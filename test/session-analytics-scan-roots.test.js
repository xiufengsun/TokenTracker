/**
 * Extra scan roots (#657) in the session browser's discovery.
 *
 * `sync` and the session browser must walk the same roots, or tokens land in
 * the totals while the sessions that produced them are missing from the
 * browser (the exact split #380 fixed for WSL). providerRoots therefore takes
 * the same extras: CLAUDE_CONFIG_DIR as the process's implicit Claude root
 * and config.scanRoots.<provider> threaded in by discoverSessionFiles.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  buildSessionAnalytics,
  discoverSessionFiles,
  providerRoots,
  resolveSessionSidecarPath,
} = require("../src/lib/session-analytics");

function writeClaudeSession(root, project, sessionId) {
  const dir = path.join(root, "projects", project);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${sessionId}.jsonl`);
  const rows = [
    { type: "user", sessionId, cwd: dir, timestamp: "2026-07-18T01:00:00Z", message: { content: [{ type: "text", text: "hi" }] } },
    { type: "assistant", sessionId, cwd: dir, timestamp: "2026-07-18T01:00:01Z", message: { id: `${sessionId}-m1`, model: "claude-test", usage: { input_tokens: 10, output_tokens: 2 }, content: [{ type: "tool_use", name: "Edit", input: {} }] } },
  ];
  fs.writeFileSync(filePath, `${rows.map(JSON.stringify).join("\n")}\n`);
  return filePath;
}

function tmpdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-sa-scan-roots-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("providerRoots appends CLAUDE_CONFIG_DIR and deps.extraRoots, deduped against the native root", (t) => {
  const home = tmpdir(t);
  const native = path.join(home, ".claude");
  const configDir = path.join(home, "agent", "claude");
  const extra = path.join(home, "work", "claude");
  for (const dir of [native, configDir, extra]) fs.mkdirSync(dir, { recursive: true });
  const alias = path.join(home, "claude-link");
  try {
    fs.symlinkSync(native, alias, "dir");
  } catch (_e) {
    t.skip("directory symlinks are not available on this platform");
    return;
  }

  const deps = { platform: "darwin", homedir: () => home, extraRoots: [extra, alias, configDir] };
  const roots = providerRoots(home, ".claude", { CLAUDE_CONFIG_DIR: configDir }, deps);
  assert.deepEqual(roots, [native, configDir, extra]);

  // Codex keeps its existing CODEX_HOME-replaces-native semantics; extras append.
  const codexRoots = providerRoots(home, ".codex", { CODEX_HOME: configDir }, { ...deps, extraRoots: [extra] });
  assert.deepEqual(codexRoots, [configDir, extra]);

  // A non-default home (an injected tree) never picks up this process's env roots.
  const other = tmpdir(t);
  assert.deepEqual(providerRoots(other, ".claude", { CLAUDE_CONFIG_DIR: configDir }, { platform: "darwin", homedir: () => home }), [path.join(other, ".claude")]);
});

test("providerRoots / discoverSessionFiles anchor a relative CODEX_HOME and CLAUDE_CONFIG_DIR to home, not cwd", async (t) => {
  const home = tmpdir(t);
  const codexRoot = path.join(home, "profiles", "codex");
  const claudeRoot = path.join(home, "profiles", "claude");
  fs.mkdirSync(path.join(codexRoot, "sessions", "2026", "06", "30"), { recursive: true });
  fs.mkdirSync(path.join(claudeRoot, "projects", "p"), { recursive: true });
  const rollout = path.join(codexRoot, "sessions", "2026", "06", "30", "rollout-2026-06-30T00-00-00-019f16bd-4444-7555-8666-777777777777.jsonl");
  const session = path.join(claudeRoot, "projects", "p", "s.jsonl");
  fs.writeFileSync(rollout, ""); fs.writeFileSync(session, "");
  const env = { CODEX_HOME: "profiles/codex", CLAUDE_CONFIG_DIR: "profiles/claude" };
  const deps = { platform: "darwin", homedir: () => home, scanRootsConfig: null };
  const cwd = process.cwd();
  process.chdir(tmpdir(t));
  try {
    assert.deepEqual(providerRoots(home, ".codex", env, deps), [codexRoot]);
    assert.deepEqual(providerRoots(home, ".claude", env, deps), [path.join(home, ".claude"), claudeRoot]);
    const discovered = await discoverSessionFiles(home, env, deps);
    assert.deepEqual(discovered.codex.flat(), [rollout]);
    assert.deepEqual(discovered.claude.flat(), [session]);
  } finally {
    process.chdir(cwd);
  }
});

test("an unreadable configured projects/ marks discovery incomplete and never caches a partial inventory", async (t) => {
  if (process.platform === "win32" || (typeof process.getuid === "function" && process.getuid() === 0)) {
    t.skip("permission bits are not enforced for this user/platform");
    return;
  }
  const home = tmpdir(t);
  const extra = path.join(home, "agent", "claude");
  writeClaudeSession(path.join(home, ".claude"), "p1", "11111111-1111-4111-8111-111111111111");
  writeClaudeSession(extra, "p2", "22222222-2222-4222-8222-222222222222");
  const trackerDir = path.join(home, ".tokentracker", "tracker");
  fs.mkdirSync(trackerDir, { recursive: true });
  fs.writeFileSync(path.join(trackerDir, "config.json"), JSON.stringify({ scanRoots: { claude: [extra] } }));
  const sidecarPath = resolveSessionSidecarPath(home);
  const metaPath = `${sidecarPath}.meta.json`;

  // Complete snapshot first.
  const complete = await buildSessionAnalytics({ home, force: true });
  assert.equal(complete.length, 2);
  assert.ok(fs.existsSync(metaPath));
  const metaBefore = fs.readFileSync(metaPath, "utf8");

  const extraProjects = path.join(extra, "projects");
  fs.chmodSync(extraProjects, 0o000);
  try {
    const discovered = await discoverSessionFiles(home, {}, { scanRootsConfig: { claude: [extra] } });
    assert.deepEqual(discovered.incomplete, [{ path: extraProjects, error: "EACCES" }]);
    assert.equal(discovered.claude.flat().length, 1, "only the readable root's session is listed");

    // Not forced, complete snapshot on disk: serve it, do not touch the cache.
    const served = await buildSessionAnalytics({ home, cacheTtlMs: 0 });
    assert.equal(served.length, 2, "the last complete snapshot wins over a partial rebuild");
    assert.equal(served.incompleteDirs.length, 1);
    assert.equal(fs.readFileSync(metaPath, "utf8"), metaBefore, "meta untouched");

    // Forced with no cache: build from what is readable, but persist nothing.
    fs.rmSync(sidecarPath, { force: true });
    fs.rmSync(metaPath, { force: true });
    const partial = await buildSessionAnalytics({ home, force: true });
    assert.equal(partial.length, 1);
    assert.equal(partial.incompleteDirs.length, 1);
    assert.equal(fs.existsSync(sidecarPath), false, "partial inventory must not be cached");
    assert.equal(fs.existsSync(metaPath), false);
  } finally {
    fs.chmodSync(extraProjects, 0o755);
  }

  // Readable again: an ordinary (non-forced) refresh rebuilds and persists a
  // complete snapshot with both roots' sessions.
  const again = await buildSessionAnalytics({ home, cacheTtlMs: 0 });
  assert.equal(again.length, 2);
  assert.equal(again.incompleteDirs.length, 0);
  assert.ok(fs.existsSync(metaPath));
  assert.equal(JSON.parse(fs.readFileSync(metaPath, "utf8")).version > 0, true);
  const persisted = fs.readFileSync(sidecarPath, "utf8").trim().split("\n");
  assert.equal(persisted.length, 2, "sidecar holds both sessions after recovery");
});

test("discoverSessionFiles walks config.scanRoots for Claude and Codex", async (t) => {
  const home = tmpdir(t);
  const nativeClaude = path.join(home, ".claude", "projects", "p1");
  const extraClaude = path.join(home, "agent", "claude");
  const extraCodex = path.join(home, "agent", "codex");
  fs.mkdirSync(nativeClaude, { recursive: true });
  fs.mkdirSync(path.join(extraClaude, "projects", "p2"), { recursive: true });
  fs.mkdirSync(path.join(extraCodex, "sessions", "2026", "06", "30"), { recursive: true });
  fs.mkdirSync(path.join(home, ".codex", "sessions", "2026", "06", "30"), { recursive: true });
  const nativeSession = path.join(nativeClaude, "s1.jsonl");
  const extraSession = path.join(extraClaude, "projects", "p2", "s2.jsonl");
  const extraRollout = path.join(extraCodex, "sessions", "2026", "06", "30", "rollout-2026-06-30T00-00-00-019f16bd-2222-7333-8444-555555555555.jsonl");
  const nativeRollout = path.join(home, ".codex", "sessions", "2026", "06", "30", "rollout-2026-06-30T00-00-00-019f16bd-1111-7222-8333-444444444444.jsonl");
  for (const file of [nativeSession, extraSession, extraRollout, nativeRollout]) fs.writeFileSync(file, "");

  const deps = {
    platform: "darwin",
    homedir: () => home,
    scanRootsConfig: { claude: ["~/agent/claude", "~/missing/claude"], codex: [extraCodex] },
  };
  const discovered = await discoverSessionFiles(home, {}, deps);
  const claude = discovered.claude.flat().sort();
  const codex = discovered.codex.flat().sort();
  assert.deepEqual(claude, [nativeSession, extraSession].sort());
  assert.deepEqual(codex, [nativeRollout, extraRollout].sort());

  // Two configured roots whose projects/ is one directory (symlink) are read once.
  const profileB = path.join(home, "profile-b");
  fs.mkdirSync(profileB, { recursive: true });
  let linked = true;
  try {
    fs.symlinkSync(path.join(home, ".claude", "projects"), path.join(profileB, "projects"), "dir");
  } catch (_e) {
    linked = false;
  }
  if (linked) {
    const withLink = await discoverSessionFiles(home, {}, { ...deps, scanRootsConfig: { claude: [extraClaude, profileB] } });
    assert.deepEqual(withLink.claude.flat().sort(), [nativeSession, extraSession].sort());
  }

  // Without config the extras are not walked (nothing else changed).
  const plain = await discoverSessionFiles(home, {}, { platform: "darwin", homedir: () => home, scanRootsConfig: null });
  assert.deepEqual(plain.claude.flat(), [nativeSession]);
  assert.deepEqual(plain.codex.flat(), [nativeRollout]);
});
