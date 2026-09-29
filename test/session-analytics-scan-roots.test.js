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

const { discoverSessionFiles, providerRoots } = require("../src/lib/session-analytics");

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

  // Without config the extras are not walked (nothing else changed).
  const plain = await discoverSessionFiles(home, {}, { platform: "darwin", homedir: () => home, scanRootsConfig: null });
  assert.deepEqual(plain.claude.flat(), [nativeSession]);
  assert.deepEqual(plain.codex.flat(), [nativeRollout]);
});
