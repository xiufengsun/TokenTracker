/**
 * splitScanRoots: an extra Claude root (CLAUDE_CONFIG_DIR / config.scanRoots.claude)
 * is filed under its own source, "claude@<profile>", instead of adding to "claude".
 *
 *   - off by default: every root keeps feeding the single "claude" source
 *   - on: native ~/.claude stays "claude", each extra root gets "claude@<name>"
 *   - the profile name comes from the folder name, never from a path
 *   - Codex is not split yet and keeps its single "codex" source
 *   - a second sync does not count anything twice
 *   - history already counted stays under "claude"; only newly appended usage moves
 *   - profile rows are local provenance: never uploaded to the cloud
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { cmdSync, readQueueBatch } = require("../src/commands/sync");
const { cmdStatus } = require("../src/commands/status");
const {
  deriveProfileName,
  normalizeSplitScanRoots,
  resolveScanRoots,
} = require("../src/lib/scan-roots");
const { baseSource, isProfileSource, profileOfSource } = require("../src/lib/profile-source");

const ENV_KEYS = [
  "HOME", "USERPROFILE", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "CODE_HOME", "GEMINI_HOME",
  "OPENCODE_HOME", "XDG_DATA_HOME", "TOKENTRACKER_DEVICE_TOKEN", "TOKENTRACKER_OPENCLAW_HOME",
  "TOKENTRACKER_OPENCLAW_AGENT_ID", "TOKENTRACKER_OPENCLAW_PREV_SESSION_ID",
  "TOKENTRACKER_OPENCLAW_SESSION_KEY", "TOKENTRACKER_INSFORGE_BASE_URL", "DSH_HOME",
  "TOKENTRACKER_DSH_HOME", "TOKENTRACKER_WSL_MODE",
];

async function withTempSyncEnv(fn) {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "tt-scan-roots-split-"));
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
    // On Windows the sync also reads a WSL ~/.claude: keep the host's real WSL history out of the totals.
    process.env.TOKENTRACKER_WSL_MODE = "native-only";
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

function claudeLines(msgId, input, output, ts) {
  return [
    JSON.stringify({ type: "user", timestamp: ts, message: { content: [{ type: "text", text: "hi" }] } }),
    JSON.stringify({
      type: "assistant",
      timestamp: ts,
      requestId: `req-${msgId}`,
      message: { id: msgId, model: "claude-sonnet-4", usage: { input_tokens: input, output_tokens: output } },
    }),
  ];
}

async function writeClaudeSession(claudeRoot, project, name, { msgId, input, output, ts = "2026-06-30T00:00:00.000Z" }) {
  const dir = path.join(claudeRoot, "projects", project);
  await fsp.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${name}.jsonl`);
  await fsp.writeFile(filePath, claudeLines(msgId, input, output, ts).join("\n") + "\n", "utf8");
  return filePath;
}

async function appendClaudeUsage(filePath, { msgId, input, output, ts = "2026-06-30T00:10:00.000Z" }) {
  await fsp.appendFile(filePath, claudeLines(msgId, input, output, ts).join("\n") + "\n", "utf8");
}

// queue.jsonl is append-only with cumulative buckets: readers take the latest
// row per (source, model, hour_start).
async function latestTotalsBySource(home) {
  let raw = "";
  try { raw = await fsp.readFile(path.join(trackerDir(home), "queue.jsonl"), "utf8"); } catch { return {}; }
  const latest = new Map();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    if (!row.source) continue;
    latest.set(`${row.source}|${row.model}|${row.hour_start}`, row);
  }
  const totals = {};
  for (const row of latest.values()) totals[row.source] = (totals[row.source] || 0) + (row.total_tokens || 0);
  return totals;
}

async function captureStdout(fn) {
  const write = process.stdout.write;
  let out = "";
  process.stdout.write = (chunk) => { out += String(chunk); return true; };
  try { await fn(); } finally { process.stdout.write = write; }
  return out;
}

async function twoProfiles(home) {
  const native = path.join(home, ".claude");
  const work = path.join(home, ".claude-work");
  await writeClaudeSession(native, "p1", "s1", { msgId: "m-native", input: 100, output: 50 });
  await writeClaudeSession(work, "p2", "s2", { msgId: "m-work", input: 200, output: 100 });
  return { native, work };
}

// ---------------------------------------------------------------- naming

test("a profile name is derived from the folder name", () => {
  assert.equal(deriveProfileName("/h/.claude-work", "claude"), "work");
  assert.equal(deriveProfileName("/h/claude-native", "claude"), "native");
  assert.equal(deriveProfileName("/h/.claude_personal", "claude"), "personal");
  assert.equal(deriveProfileName("/h/agents/research", "claude"), "research");
  assert.equal(deriveProfileName("/h/My Client Stuff", "claude"), "my-client-stuff");
});

test("a root whose own name says nothing falls back to its parent folder", () => {
  assert.equal(deriveProfileName("/h/team/.claude", "claude"), "team");
  assert.equal(deriveProfileName("/.claude", "claude"), "profile");
});

test("a profile name never contains a path separator or the bucket-key separator", () => {
  for (const name of [deriveProfileName("/h/a|b", "claude"), deriveProfileName("/h/a@b", "claude"), deriveProfileName("/h/a b/c:d", "claude")]) {
    assert.match(name, /^[a-z0-9._-]+$/);
  }
});

test("splitScanRoots accepts true or a per-provider object and treats anything else as off", () => {
  assert.deepEqual(normalizeSplitScanRoots(true), { codex: true, claude: true });
  assert.deepEqual(normalizeSplitScanRoots({ claude: true }), { codex: false, claude: true });
  assert.deepEqual(normalizeSplitScanRoots({ claude: "yes", codex: 1 }), { codex: false, claude: false });
  for (const bad of [undefined, null, false, "true", 1, [], ["claude"]]) {
    assert.deepEqual(normalizeSplitScanRoots(bad), { codex: false, claude: false }, JSON.stringify(bad));
  }
});

test("two roots with the same folder name get distinct profile sources", () => {
  const roots = resolveScanRoots({
    home: "/h",
    env: {},
    config: { scanRoots: { claude: ["/a/.claude-work", "/b/claude-work"] }, splitScanRoots: true },
    base: { claude: ["/h/.claude"] },
  }).claude;
  assert.deepEqual(roots.map((entry) => entry.source), ["claude", "claude@work", "claude@work-2"]);
});

test("the native root is never split, and without the switch no root is", () => {
  const config = { scanRoots: { claude: ["/h/.claude-work"] } };
  const off = resolveScanRoots({ home: "/h", env: {}, config, base: { claude: ["/h/.claude"] } }).claude;
  assert.deepEqual(off.map((entry) => entry.source), ["claude", "claude"]);
  const on = resolveScanRoots({ home: "/h", env: {}, config: { ...config, splitScanRoots: true }, base: { claude: ["/h/.claude"] } }).claude;
  assert.deepEqual(on.map((entry) => [entry.origin, entry.source]), [["native", "claude"], ["config", "claude@work"]]);
});

test("Codex roots are not split yet, even when asked", () => {
  const roots = resolveScanRoots({
    home: "/h",
    env: {},
    config: { scanRoots: { codex: ["/h/.codex-work"] }, splitScanRoots: { codex: true } },
    base: { codex: ["/h/.codex"] },
  }).codex;
  assert.deepEqual(roots.map((entry) => entry.source), ["codex", "codex"]);
});

test("profile-source helpers", () => {
  assert.equal(baseSource("claude@work"), "claude");
  assert.equal(baseSource("claude"), "claude");
  assert.equal(baseSource("claude-mem"), "claude-mem");
  assert.equal(baseSource(undefined), undefined);
  assert.equal(isProfileSource("claude@work"), true);
  assert.equal(isProfileSource("claude-mem"), false);
  assert.equal(profileOfSource("claude@work"), "work");
  assert.equal(profileOfSource("claude"), null);
});

// ---------------------------------------------------------------- sync

test("off by default: every Claude root feeds the single claude source", async () => {
  await withTempSyncEnv(async (home) => {
    const { work } = await twoProfiles(home);
    await writeConfig(home, { scanRoots: { claude: [work] } });

    await cmdSync([]);

    assert.deepEqual(await latestTotalsBySource(home), { claude: 450 });
  });
});

test("on: the native root stays claude and each extra root is its own source", async () => {
  await withTempSyncEnv(async (home) => {
    const { work } = await twoProfiles(home);
    const envRoot = path.join(home, "profiles", "claude-research");
    await writeClaudeSession(envRoot, "p3", "s3", { msgId: "m-env", input: 10, output: 5 });
    await writeConfig(home, { scanRoots: { claude: [work] }, splitScanRoots: true });
    process.env.CLAUDE_CONFIG_DIR = envRoot;

    await cmdSync([]);

    assert.deepEqual(await latestTotalsBySource(home), {
      claude: 150,
      "claude@work": 300,
      "claude@research": 15,
    });
  });
});

test("on, per provider: { claude: true } splits Claude and nothing else", async () => {
  await withTempSyncEnv(async (home) => {
    const { work } = await twoProfiles(home);
    await writeConfig(home, { scanRoots: { claude: [work] }, splitScanRoots: { claude: true } });

    await cmdSync([]);

    assert.deepEqual(await latestTotalsBySource(home), { claude: 150, "claude@work": 300 });
  });
});

test("on, but only for Codex: Claude is not split", async () => {
  await withTempSyncEnv(async (home) => {
    const { work } = await twoProfiles(home);
    await writeConfig(home, { scanRoots: { claude: [work] }, splitScanRoots: { codex: true } });

    await cmdSync([]);

    assert.deepEqual(await latestTotalsBySource(home), { claude: 450 });
  });
});

test("a second sync counts nothing twice", async () => {
  await withTempSyncEnv(async (home) => {
    const { work } = await twoProfiles(home);
    await writeConfig(home, { scanRoots: { claude: [work] }, splitScanRoots: true });

    await cmdSync([]);
    const first = await latestTotalsBySource(home);
    await cmdSync([]);
    await cmdSync([]);

    assert.deepEqual(first, { claude: 150, "claude@work": 300 });
    assert.deepEqual(await latestTotalsBySource(home), first);
  });
});

test("a profile root that is not on disk is ignored and does not break the sync", async () => {
  await withTempSyncEnv(async (home) => {
    await writeClaudeSession(path.join(home, ".claude"), "p1", "s1", { msgId: "m1", input: 100, output: 50 });
    await writeConfig(home, { scanRoots: { claude: [path.join(home, "gone", ".claude-work")] }, splitScanRoots: true });

    await cmdSync([]);

    assert.deepEqual(await latestTotalsBySource(home), { claude: 150 });
  });
});

test("turning the split on later leaves history under claude; only newly appended usage moves", async () => {
  await withTempSyncEnv(async (home) => {
    const { work } = await twoProfiles(home);
    await writeConfig(home, { scanRoots: { claude: [work] } });
    await cmdSync([]);
    assert.deepEqual(await latestTotalsBySource(home), { claude: 450 });

    await writeConfig(home, { scanRoots: { claude: [work] }, splitScanRoots: true });
    await appendClaudeUsage(path.join(work, "projects", "p2", "s2.jsonl"), { msgId: "m-work-2", input: 20, output: 10 });
    await cmdSync([]);

    assert.deepEqual(await latestTotalsBySource(home), { claude: 450, "claude@work": 30 });
  });
});

test("turning the split off again files new usage back under claude", async () => {
  await withTempSyncEnv(async (home) => {
    const { work } = await twoProfiles(home);
    await writeConfig(home, { scanRoots: { claude: [work] }, splitScanRoots: true });
    await cmdSync([]);

    await writeConfig(home, { scanRoots: { claude: [work] } });
    await appendClaudeUsage(path.join(work, "projects", "p2", "s2.jsonl"), { msgId: "m-work-2", input: 20, output: 10 });
    await cmdSync([]);

    assert.deepEqual(await latestTotalsBySource(home), { claude: 180, "claude@work": 300 });
  });
});

test("status says which source a split root is filed under", async () => {
  await withTempSyncEnv(async (home) => {
    const { work } = await twoProfiles(home);
    await writeConfig(home, { scanRoots: { claude: [work] }, splitScanRoots: true });
    await cmdSync([]);

    const out = await captureStdout(() => cmdStatus([]));

    assert.match(out, /claude scanRoots, source claude@work: .*\.claude-work/);
  });
});

test("status names the split profiles and says they stay local", async () => {
  await withTempSyncEnv(async (home) => {
    const { work } = await twoProfiles(home);
    await writeConfig(home, { scanRoots: { claude: [work] }, splitScanRoots: true });
    await cmdSync([]);

    const out = await captureStdout(() => cmdStatus([]));

    assert.ok(out.includes("- Split profiles: claude@work (local only: not uploaded to Cloud; history counted before the split stays under claude)"), out);
    assert.doesNotMatch(out, /Codex is not supported yet/, "true means every provider that supports it; no Codex note");
  });
});

test("status has no split-profiles line when the switch is off", async () => {
  await withTempSyncEnv(async (home) => {
    const { work } = await twoProfiles(home);
    await writeConfig(home, { scanRoots: { claude: [work] } });
    await cmdSync([]);

    const out = await captureStdout(() => cmdStatus([]));

    assert.doesNotMatch(out, /Split profiles/);
  });
});

test("status says Codex cannot be split yet instead of silently ignoring the request", async () => {
  await withTempSyncEnv(async (home) => {
    await twoProfiles(home);
    await writeConfig(home, { splitScanRoots: { codex: true } });
    await cmdSync([]);

    const out = await captureStdout(() => cmdStatus([]));

    assert.match(out, /- Split profiles: Codex is not supported yet; its roots are merged into codex/);
  });
});

// ---------------------------------------------------------------- upload

async function writeQueue(file, rows) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
  return (await fsp.stat(file)).size;
}

const bucket = (source, total) => ({
  hour_start: "2026-06-30T00:00:00.000Z",
  source,
  model: "claude-sonnet-4",
  input_tokens: total,
  output_tokens: 0,
  cached_input_tokens: 0,
  cache_creation_input_tokens: 0,
  reasoning_output_tokens: 0,
  total_tokens: total,
  conversation_count: 1,
});

test("upload reads plain sources and skips split-profile rows, still consuming their bytes", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "tt-split-upload-"));
  try {
    const queue = path.join(dir, "queue.jsonl");
    const size = await writeQueue(queue, [bucket("claude", 150), bucket("claude@work", 300), bucket("codex", 7)]);

    const batch = await readQueueBatch(queue, 0, 200);

    assert.deepEqual(batch.buckets.map((row) => row.source).sort(), ["claude", "codex"]);
    assert.equal(batch.buckets.some((row) => String(row.source).includes("@")), false);
    assert.equal(batch.nextOffset, size, "the skipped row's bytes are consumed, not retried forever");
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("a batch of only split-profile rows uploads nothing but still advances the offset", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "tt-split-upload-"));
  try {
    const queue = path.join(dir, "queue.jsonl");
    const size = await writeQueue(queue, [bucket("claude@work", 300), bucket("claude@research", 15)]);

    const batch = await readQueueBatch(queue, 0, 200);

    assert.deepEqual(batch.buckets, []);
    assert.equal(batch.nextOffset, size);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- pending ground-truth repair

// The one-time Claude repair rebuilds every "claude" row from the roots it is
// given. A root that was already scanned into "claude" before the split was
// turned on holds history that belongs there ("history stays under claude"), so
// the repair must still count it, not drop it.
async function makeGroundTruthRepairPending(home) {
  const file = path.join(trackerDir(home), "cursors.json");
  const cursors = JSON.parse(await fsp.readFile(file, "utf8"));
  const keys = Object.keys(cursors.migrations || {}).filter((key) => key.startsWith("claudeGroundTruthRepair"));
  assert.ok(keys.length > 0, "the first sync records the repair as done");
  for (const key of keys) delete cursors.migrations[key];
  await fsp.writeFile(file, JSON.stringify(cursors), "utf8");
}

test("a pending repair keeps history that an extra root already added to claude before the split", async () => {
  await withTempSyncEnv(async (home) => {
    const { work } = await twoProfiles(home);
    await writeConfig(home, { scanRoots: { claude: [work] } });
    await cmdSync([]);
    assert.deepEqual(await latestTotalsBySource(home), { claude: 450 });
    await makeGroundTruthRepairPending(home);

    // The repair reads the files as they are on disk, so usage appended just
    // before this sync is part of the history it keeps under "claude".
    await writeConfig(home, { scanRoots: { claude: [work] }, splitScanRoots: true });
    await appendClaudeUsage(path.join(work, "projects", "p2", "s2.jsonl"), { msgId: "m-work-2", input: 20, output: 10 });
    await cmdSync([]);
    assert.deepEqual(await latestTotalsBySource(home), { claude: 480 });

    // From here on the split root's new usage goes to its profile.
    await appendClaudeUsage(path.join(work, "projects", "p2", "s2.jsonl"), { msgId: "m-work-3", input: 6, output: 4 });
    await cmdSync([]);
    assert.deepEqual(await latestTotalsBySource(home), { claude: 480, "claude@work": 10 });
  });
});

test("a pending repair does not count a new split root's files as plain claude", async () => {
  await withTempSyncEnv(async (home) => {
    const { work } = await twoProfiles(home);
    await writeConfig(home, { scanRoots: { claude: [work] }, splitScanRoots: true });

    await cmdSync([]);

    assert.deepEqual(await latestTotalsBySource(home), { claude: 150, "claude@work": 300 });
  });
});

test("the repair finishing does not make a later sync count anything twice", async () => {
  await withTempSyncEnv(async (home) => {
    const { work } = await twoProfiles(home);
    await writeConfig(home, { scanRoots: { claude: [work] } });
    await cmdSync([]);
    await makeGroundTruthRepairPending(home);
    await writeConfig(home, { scanRoots: { claude: [work] }, splitScanRoots: true });
    await cmdSync([]);
    const first = await latestTotalsBySource(home);

    await cmdSync([]);
    await cmdSync([]);

    assert.deepEqual(await latestTotalsBySource(home), first);
  });
});

// ---------------------------------------------------------------- stable naming

function profileSourcesByPath(configRoots, extra = {}) {
  const entries = resolveScanRoots({
    home: "/h",
    env: {},
    config: { scanRoots: { claude: configRoots }, splitScanRoots: true },
    base: { claude: ["/h/.claude"] },
    ...extra,
  }).claude;
  return Object.fromEntries(entries.filter((entry) => entry.origin !== "native").map((entry) => [entry.path, entry.source]));
}

test("two roots with the same folder name keep their sources when the configured order changes", () => {
  const forward = profileSourcesByPath(["/a/.claude-work", "/b/claude-work"]);
  const reversed = profileSourcesByPath(["/b/claude-work", "/a/.claude-work"]);
  assert.deepEqual(reversed, forward);
  assert.deepEqual(forward, {
    [path.resolve("/a/.claude-work")]: "claude@work",
    [path.resolve("/b/claude-work")]: "claude@work-2",
  });
});

test("a root that sorts later keeps its name when another root with a different name is added", () => {
  const before = profileSourcesByPath(["/b/.claude-work"]);
  const after = profileSourcesByPath(["/a/.claude-personal", "/b/.claude-work"]);
  assert.equal(after[path.resolve("/b/.claude-work")], before[path.resolve("/b/.claude-work")]);
});

test("a very long folder name is capped so its source stays within the snapshot limit", () => {
  const name = deriveProfileName(`/h/.claude-${"x".repeat(300)}`, "claude");
  assert.ok(name.length <= 64, `profile name has ${name.length} characters`);
  assert.match(name, /^[a-z0-9][a-z0-9._-]*$/);
  const [source] = Object.values(profileSourcesByPath([`/h/.claude-${"y".repeat(300)}`]));
  assert.ok(source.length <= 80 + 1 + 80);
  assert.match(source, /^claude@[a-z0-9][a-z0-9._-]{0,63}$/);
});

test("a capped name that ends in a separator is trimmed", () => {
  const name = deriveProfileName(`/h/.claude-${"a".repeat(63)}-bbbb`, "claude");
  assert.ok(name.length <= 64);
  assert.doesNotMatch(name, /[-._]$/);
});
