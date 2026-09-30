/**
 * Extra scan roots (#657) end to end through `sync` and `status`.
 *
 *   - a Codex root listed in config.scanRoots.codex is scanned, and its
 *     rollouts are classified as Codex cursor paths (per-day shard, not
 *     core.json) by EVERY producer — including a sync whose CODEX_HOME points
 *     elsewhere. Alternating two such producers never re-parses a file, so the
 *     bucket total stays put (#639 was linear growth on every alternation).
 *   - a Claude root listed in config.scanRoots.claude and the process's
 *     CLAUDE_CONFIG_DIR are scanned in addition to ~/.claude
 *   - a profile whose projects/ is a symlink to another profile's projects/
 *     is read once (one cursor, not two)
 *   - a configured root that does not exist is ignored, sync still succeeds
 *   - `status` lists the extra roots
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { cmdSync } = require("../src/commands/sync");
const { cmdStatus } = require("../src/commands/status");

const ENV_KEYS = [
  "HOME", "USERPROFILE", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "CODE_HOME", "GEMINI_HOME",
  "OPENCODE_HOME", "XDG_DATA_HOME", "TOKENTRACKER_DEVICE_TOKEN", "TOKENTRACKER_OPENCLAW_HOME",
  "TOKENTRACKER_OPENCLAW_AGENT_ID", "TOKENTRACKER_OPENCLAW_PREV_SESSION_ID",
  "TOKENTRACKER_OPENCLAW_SESSION_KEY", "TOKENTRACKER_INSFORGE_BASE_URL", "DSH_HOME",
  "TOKENTRACKER_DSH_HOME",
];

async function withTempSyncEnv(fn) {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "tt-scan-roots-sync-"));
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  try {
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.CODEX_HOME = path.join(home, ".codex");
    process.env.CODE_HOME = path.join(home, ".code");
    process.env.GEMINI_HOME = path.join(home, ".gemini");
    process.env.OPENCODE_HOME = path.join(home, ".opencode");
    process.env.XDG_DATA_HOME = path.join(home, ".local", "share");
    process.env.TOKENTRACKER_OPENCLAW_HOME = path.join(home, ".openclaw");
    for (const key of [
      "CLAUDE_CONFIG_DIR", "TOKENTRACKER_DEVICE_TOKEN", "TOKENTRACKER_INSFORGE_BASE_URL",
      "TOKENTRACKER_OPENCLAW_AGENT_ID", "TOKENTRACKER_OPENCLAW_PREV_SESSION_ID",
      "TOKENTRACKER_OPENCLAW_SESSION_KEY", "DSH_HOME", "TOKENTRACKER_DSH_HOME",
    ]) delete process.env[key];
    return await fn(home);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fsp.rm(home, { recursive: true, force: true });
  }
}

const trackerDir = (home) => path.join(home, ".tokentracker", "tracker");

async function writeConfig(home, config) {
  await fsp.mkdir(trackerDir(home), { recursive: true });
  await fsp.writeFile(path.join(trackerDir(home), "config.json"), JSON.stringify(config), "utf8");
}

function tokenCountLine({ ts, total }) {
  const usage = {
    input_tokens: total,
    cached_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: total,
  };
  return JSON.stringify({
    type: "event_msg",
    timestamp: ts,
    payload: { type: "token_count", info: { last_token_usage: usage, total_token_usage: usage } },
  });
}

async function writeCodexRollout(codexRoot, date, uuid, total) {
  const [year, month, day] = date.split("-");
  const dir = path.join(codexRoot, "sessions", year, month, day);
  await fsp.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `rollout-${date}T00-00-00-${uuid}.jsonl`);
  await fsp.writeFile(filePath, tokenCountLine({ ts: `${date}T00:00:00.000Z`, total }) + "\n", "utf8");
  return filePath;
}

async function writeClaudeSession(claudeRoot, project, name, { msgId, input, output }) {
  const dir = path.join(claudeRoot, "projects", project);
  await fsp.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${name}.jsonl`);
  const ts = "2026-06-30T00:00:00.000Z";
  const lines = [
    JSON.stringify({ type: "user", timestamp: ts, message: { content: [{ type: "text", text: "hi" }] } }),
    JSON.stringify({
      type: "assistant",
      timestamp: ts,
      requestId: `req-${msgId}`,
      message: { id: msgId, model: "claude-sonnet-4", usage: { input_tokens: input, output_tokens: output } },
    }),
  ];
  await fsp.writeFile(filePath, lines.join("\n") + "\n", "utf8");
  return filePath;
}

// queue.jsonl is append-only with cumulative buckets: readers take the latest
// row per (source, model, hour_start).
async function latestTotals(home, source) {
  let raw = "";
  try { raw = await fsp.readFile(path.join(trackerDir(home), "queue.jsonl"), "utf8"); } catch { return 0; }
  const latest = new Map();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    if (row.source !== source) continue;
    latest.set(`${row.model}|${row.hour_start}`, row);
  }
  return [...latest.values()].reduce((sum, row) => sum + (row.total_tokens || 0), 0);
}

async function readV2Store(home) {
  const base = path.join(trackerDir(home), "cursor-store-v2");
  const manifest = JSON.parse(await fsp.readFile(path.join(base, "manifest.json"), "utf8"));
  const gen = path.join(base, "generations", manifest.current);
  const core = JSON.parse(await fsp.readFile(path.join(gen, "core.json"), "utf8"));
  const shards = {};
  try {
    for (const name of await fsp.readdir(path.join(gen, "codex-files"))) {
      shards[name.replace(/\.json$/, "")] = JSON.parse(await fsp.readFile(path.join(gen, "codex-files", name), "utf8"));
    }
  } catch { /* no shards */ }
  return { core, shards };
}

async function captureStdout(fn) {
  const write = process.stdout.write;
  let out = "";
  process.stdout.write = (chunk) => { out += String(chunk); return true; };
  try { await fn(); } finally { process.stdout.write = write; }
  return out;
}

test("configured Codex root: scanned, sharded by every producer, stable across CODEX_HOME alternation", async () => {
  await withTempSyncEnv(async (home) => {
    const native = path.join(home, ".codex");
    const extra = path.join(home, "agent-home", "codex"); // deliberately not under a ".codex" segment
    await writeCodexRollout(native, "2026-06-30", "019f16bd-1111-7222-8333-444444444444", 40);
    const extraRollout = await writeCodexRollout(extra, "2026-06-30", "019f16bd-2222-7333-8444-555555555555", 25);
    await writeConfig(home, { scanRoots: { codex: [extra] } });

    const forceV2 = { cursorStoreOptions: { forceV2: true } };
    const producerA = async () => { process.env.CODEX_HOME = native; await cmdSync([], forceV2); };
    const producerB = async () => { process.env.CODEX_HOME = extra; await cmdSync([], forceV2); };

    await producerA();
    assert.equal(await latestTotals(home, "codex"), 65, "both roots counted on the first full scan");
    let store = await readV2Store(home);
    assert.ok(!(extraRollout in (store.core.files || {})), "extra-root rollout must not be filed in core.json");
    assert.ok(store.shards["2026-06-30"] && extraRollout in store.shards["2026-06-30"], "extra-root rollout is filed in its per-day shard");

    for (const producer of [producerB, producerA, producerB, producerA]) {
      await producer();
      assert.equal(await latestTotals(home, "codex"), 65, "no re-parse on producer alternation");
      store = await readV2Store(home);
      assert.ok(!(extraRollout in (store.core.files || {})));
      assert.ok(extraRollout in store.shards["2026-06-30"]);
    }
  });
});

test("relative CODEX_HOME from a foreign cwd: discovery and cursor roots agree on one real root, no replay across cwd changes", async () => {
  await withTempSyncEnv(async (home) => {
    const realRoot = path.join(home, "profiles", "codex");
    const rollout = await writeCodexRollout(realRoot, "2026-06-30", "019f16bd-4444-7555-8666-777777777777", 33);
    process.env.CODEX_HOME = path.join("profiles", "codex"); // relative on purpose
    const originalCwd = process.cwd();
    const cwdA = await fsp.mkdtemp(path.join(os.tmpdir(), "tt-cwd-a-"));
    const cwdB = await fsp.mkdtemp(path.join(os.tmpdir(), "tt-cwd-b-"));
    const forceV2 = { cursorStoreOptions: { forceV2: true } };
    try {
      process.chdir(cwdA);
      await cmdSync([], forceV2);
      assert.equal(await latestTotals(home, "codex"), 33, "rollout under <home>/profiles/codex was scanned");
      let store = await readV2Store(home);
      const codexCursorKeys = [
        ...Object.keys(store.core.files || {}),
        ...Object.values(store.shards).flatMap((shard) => Object.keys(shard)),
      ].filter((key) => key.includes(`${path.sep}profiles${path.sep}codex${path.sep}`));
      assert.deepEqual(codexCursorKeys, [rollout], "exactly one cursor, keyed under the home-anchored root");
      assert.ok(!(rollout in (store.core.files || {})), "must not be filed in core.json");
      assert.ok(store.shards["2026-06-30"] && rollout in store.shards["2026-06-30"], "must be filed in the per-day shard: codexRoots and discovery agree");
      assert.ok(!Object.keys(store.core.files || {}).concat(...Object.values(store.shards).map(Object.keys))
        .some((key) => key.startsWith(cwdA)), "nothing was resolved under the process cwd");

      // Another producer with a different cwd sees the same root: no re-parse.
      process.chdir(cwdB);
      await cmdSync([], forceV2);
      assert.equal(await latestTotals(home, "codex"), 33, "no replay when cwd changes");
      store = await readV2Store(home);
      assert.ok(rollout in store.shards["2026-06-30"]);

      const out = await captureStdout(() => cmdStatus([]));
      // Template literal: [\\\\/] survives as [\\/] in the regex source, matching either separator.
      assert.match(out, new RegExp(`- Codex CLI: sessions found \\(native: ${realRoot.replace(/[\\/]/g, "[\\\\/]")}[\\\\/]sessions\\)`));
    } finally {
      process.chdir(originalCwd);
      await fsp.rm(cwdA, { recursive: true, force: true });
      await fsp.rm(cwdB, { recursive: true, force: true });
    }
  });
});

test("Claude: config.scanRoots.claude and CLAUDE_CONFIG_DIR are scanned in addition to ~/.claude; symlinked projects/ read once", async (t) => {
  await withTempSyncEnv(async (home) => {
    const native = path.join(home, ".claude");
    const configRoot = path.join(home, "agent-home", "claude");
    const envRoot = path.join(home, "env-home", "claude");
    const nativeFile = await writeClaudeSession(native, "p1", "s1", { msgId: "m1", input: 100, output: 50 });
    await writeClaudeSession(configRoot, "p2", "s2", { msgId: "m2", input: 200, output: 100 });
    await writeClaudeSession(envRoot, "p3", "s3", { msgId: "m3", input: 10, output: 5 });
    // profile-b shares ~/.claude/projects through a symlink
    const profileB = path.join(home, "profile-b");
    await fsp.mkdir(profileB, { recursive: true });
    try {
      await fsp.symlink(path.join(native, "projects"), path.join(profileB, "projects"), "dir");
    } catch (_e) {
      t.skip("directory symlinks are not available on this platform");
      return;
    }
    await writeConfig(home, { scanRoots: { claude: [configRoot, "~/profile-b"] } });
    process.env.CLAUDE_CONFIG_DIR = envRoot;

    await cmdSync([]);
    assert.equal(await latestTotals(home, "claude"), 465, "native + config root + CLAUDE_CONFIG_DIR root");

    const cursors = JSON.parse(await fsp.readFile(path.join(trackerDir(home), "cursors.json"), "utf8"));
    const s1Keys = Object.keys(cursors.files || {}).filter((key) => key.endsWith(path.join("p1", "s1.jsonl")));
    assert.deepEqual(s1Keys, [nativeFile], "the symlinked profile must not produce a second cursor for the same file");

    const out = await captureStdout(() => cmdStatus([]));
    assert.match(out, /- Extra scan roots: claude CLAUDE_CONFIG_DIR: .*env-home[\\/]claude \| claude scanRoots: .*agent-home[\\/]claude \| claude scanRoots: .*profile-b/);
    assert.match(out, /- Claude Code: projects found \(native: .*[\\/]\.claude[\\/]projects \| CLAUDE_CONFIG_DIR: .*env-home[\\/]claude[\\/]projects \| scanRoots: .*agent-home[\\/]claude[\\/]projects \| scanRoots: .*profile-b[\\/]projects\)/);
  });
});

test("a configured root that is not on disk is ignored by sync and flagged by status", async () => {
  await withTempSyncEnv(async (home) => {
    const native = path.join(home, ".codex");
    await writeCodexRollout(native, "2026-06-30", "019f16bd-3333-7444-8555-666666666666", 12);
    const missing = path.join(home, "gone", "codex");
    await writeConfig(home, { scanRoots: { codex: [missing], claude: [path.join(home, "gone", "claude")] } });

    await cmdSync([]);
    assert.equal(await latestTotals(home, "codex"), 12);

    const out = await captureStdout(() => cmdStatus([]));
    assert.match(out, /- Extra scan roots: codex scanRoots: .*gone[\\/]codex \(missing\) \| claude scanRoots: .*gone[\\/]claude \(missing\)/);
    assert.doesNotMatch(out, /scanRoots: .*gone[\\/]codex[\\/]sessions/);

    // Structured output carries the same records.
    const json = JSON.parse(await captureStdout(() => cmdStatus(["--json"])));
    assert.deepEqual(json.extra_scan_roots, [
      { provider: "codex", origin: "scanRoots", path: missing, exists: false, error: null },
      { provider: "claude", origin: "scanRoots", path: path.join(home, "gone", "claude"), exists: false, error: null },
    ]);
    const light = await captureStdout(() => cmdStatus(["--light"]));
    assert.match(light, /Scan root · codex.*scanRoots: .*gone[\\/]codex \(missing\)/);
  });
});

test("full scan defers the Claude ground-truth repair while a configured Claude root is unavailable", async () => {
  await withTempSyncEnv(async (home) => {
    const native = path.join(home, ".claude");
    const extra = path.join(home, "agent-home", "claude");
    await writeClaudeSession(native, "p1", "s1", { msgId: "m1", input: 100, output: 50 });
    await writeConfig(home, { scanRoots: { claude: [extra] } });
    const migrationKey = "claudeGroundTruthRepair_2026_05_v4";
    const readMigrations = async () =>
      JSON.parse(await fsp.readFile(path.join(trackerDir(home), "cursors.json"), "utf8")).migrations || {};

    // A scoped hook sync queues rows without running the (full-scan-only) repair.
    await cmdSync(["--auto", "--from-notify", "--source", "claude"]);
    assert.equal(await latestTotals(home, "claude"), 150);
    assert.equal((await readMigrations())[migrationKey], undefined);

    // Full scan with the configured root still absent: rows survive, repair deferred.
    await cmdSync([]);
    assert.equal(await latestTotals(home, "claude"), 150);
    assert.equal((await readMigrations())[migrationKey], undefined, "repair must not run from an incomplete root list");

    // Root appears: the next full scan runs the repair and counts it.
    await writeClaudeSession(extra, "p2", "s2", { msgId: "m2", input: 10, output: 5 });
    await cmdSync([]);
    assert.equal(await latestTotals(home, "claude"), 165);
    assert.ok((await readMigrations())[migrationKey], "repair ran once the root was available");
  });
});

test("full scan defers the Claude ground-truth repair when a previously scanned projects/ has vanished, but not for a new root without one", async () => {
  await withTempSyncEnv(async (home) => {
    const native = path.join(home, ".claude");
    const extra = path.join(home, "agent-home", "claude");
    const fresh = path.join(home, "fresh-profile"); // exists, never had projects/
    await writeClaudeSession(native, "p1", "s1", { msgId: "m1", input: 100, output: 50 });
    await writeClaudeSession(extra, "p2", "s2", { msgId: "m2", input: 10, output: 5 });
    await fsp.mkdir(fresh, { recursive: true });
    await writeConfig(home, { scanRoots: { claude: [extra, fresh] } });
    const migrationKey = "claudeGroundTruthRepair_2026_05_v4";
    const readMigrations = async () =>
      JSON.parse(await fsp.readFile(path.join(trackerDir(home), "cursors.json"), "utf8")).migrations || {};

    // Scoped sync records cursors for files under both roots (no repair yet).
    await cmdSync(["--auto", "--from-notify", "--source", "claude"]);
    assert.equal(await latestTotals(home, "claude"), 165);
    assert.equal((await readMigrations())[migrationKey], undefined);

    // The extra root's projects/ disappears while the root itself stays.
    await fsp.rm(path.join(extra, "projects"), { recursive: true, force: true });
    await cmdSync([]);
    assert.equal(await latestTotals(home, "claude"), 165, "rows from the vanished projects/ survive");
    assert.equal((await readMigrations())[migrationKey], undefined, "repair must defer: this root supplied files before");

    // projects/ is back: the repair runs. The fresh root's absent projects/ never blocked it.
    await writeClaudeSession(extra, "p2", "s2", { msgId: "m2", input: 10, output: 5 });
    await cmdSync([]);
    assert.equal(await latestTotals(home, "claude"), 165);
    assert.ok((await readMigrations())[migrationKey], "repair ran once projects/ was back; fresh root with no history did not block it");
  });
});

test("full scan defers the Claude ground-truth repair while a configured root's projects/ cannot be listed", async (t) => {
  if (process.platform === "win32" || (typeof process.getuid === "function" && process.getuid() === 0)) {
    t.skip("permission bits are not enforced for this user/platform");
    return;
  }
  await withTempSyncEnv(async (home) => {
    const native = path.join(home, ".claude");
    const extra = path.join(home, "agent-home", "claude");
    await writeClaudeSession(native, "p1", "s1", { msgId: "m1", input: 100, output: 50 });
    await writeClaudeSession(extra, "p2", "s2", { msgId: "m2", input: 10, output: 5 });
    await writeConfig(home, { scanRoots: { claude: [extra] } });
    const migrationKey = "claudeGroundTruthRepair_2026_05_v4";
    const readMigrations = async () =>
      JSON.parse(await fsp.readFile(path.join(trackerDir(home), "cursors.json"), "utf8")).migrations || {};

    // Both roots readable: a scoped sync queues rows from both.
    await cmdSync(["--auto", "--from-notify", "--source", "claude"]);
    assert.equal(await latestTotals(home, "claude"), 165);

    // The configured root stays present, but its projects/ becomes unlistable.
    const extraProjects = path.join(extra, "projects");
    await fsp.chmod(extraProjects, 0o000);
    try {
      await cmdSync([]);
      assert.equal(await latestTotals(home, "claude"), 165, "rows from the unreadable root survive");
      assert.equal((await readMigrations())[migrationKey], undefined, "repair must not run against an unreadable projects/");
    } finally {
      await fsp.chmod(extraProjects, 0o755);
    }

    // Readable again: the next full scan runs the repair.
    await cmdSync([]);
    assert.equal(await latestTotals(home, "claude"), 165);
    assert.ok((await readMigrations())[migrationKey], "repair ran once projects/ was readable");
  });
});
