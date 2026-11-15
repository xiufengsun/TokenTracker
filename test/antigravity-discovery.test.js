"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const fssync = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { afterEach, describe, it } = require("node:test");

const {
  ACP_BRAIN_REL,
  T3_ANTIGRAVITY_REL,
  discoverT3AntigravityBrainDirs,
  formatAntigravityHostStatus,
  hostDiscoveryIncomplete,
  mergeAntigravityInventories,
  resolveT3AntigravityParent,
  resolveT3Home,
} = require("../src/lib/antigravity-discovery");
const {
  listAntigravityTranscriptsWithStatus,
  parseAntigravityIncremental,
} = require("../src/lib/rollout");

const sandboxes = [];

async function makeSandbox() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tt-antigravity-discovery-"));
  sandboxes.push(dir);
  return dir;
}

afterEach(async () => {
  while (sandboxes.length > 0) {
    const dir = sandboxes.pop();
    try {
      await fs.chmod(dir, 0o700).catch(() => {});
      // Restore any chmod'd children so cleanup can recurse.
      await restoreModes(dir);
      await fs.rm(dir, { recursive: true, force: true });
    } catch (_err) {
      // best-effort
    }
  }
});

async function restoreModes(root) {
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    try {
      await fs.chmod(current, 0o755);
    } catch (_err) {
      continue;
    }
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (_err) {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) stack.push(path.join(current, entry.name));
    }
  }
}

function t3HomeOf(home) {
  return path.join(home, ".t3");
}

async function writeBrain(t3Home, profileId, sessionId, contents = "") {
  const brainDir = path.join(t3Home, T3_ANTIGRAVITY_REL, profileId, ACP_BRAIN_REL);
  const transcript = path.join(
    brainDir,
    sessionId,
    ".system_generated",
    "logs",
    "transcript.jsonl",
  );
  await fs.mkdir(path.dirname(transcript), { recursive: true });
  await fs.writeFile(transcript, contents);
  return { brainDir, transcript };
}

describe("resolveT3Home", () => {
  it("defaults to ~/.t3 under the given home", () => {
    assert.equal(resolveT3Home({ home: "/Users/demo", env: {} }), path.join("/Users/demo", ".t3"));
  });

  it("honors TOKENTRACKER_T3_HOME, including ~ expansion", () => {
    assert.equal(
      resolveT3Home({ home: "/Users/demo", env: { TOKENTRACKER_T3_HOME: "/opt/t3-state" } }),
      path.resolve("/opt/t3-state"),
    );
    assert.equal(
      resolveT3Home({ home: "/Users/demo", env: { TOKENTRACKER_T3_HOME: "~/custom-t3" } }),
      path.resolve("/Users/demo", "custom-t3"),
    );
    assert.equal(
      resolveT3AntigravityParent({ home: "/Users/demo", env: {} }),
      path.join("/Users/demo", ".t3", T3_ANTIGRAVITY_REL),
    );
  });
});

describe("discoverT3AntigravityBrainDirs", () => {
  it("finds every default T3 antigravity-acp profile without configuration", async () => {
    const home = await makeSandbox();
    const t3Home = t3HomeOf(home);
    const first = await writeBrain(t3Home, "profile-aaa", "conv-1");
    const second = await writeBrain(t3Home, "profile-bbb", "conv-2");
    // A profile directory that does not yet have an acp/brain tree is ignored.
    await fs.mkdir(path.join(t3Home, T3_ANTIGRAVITY_REL, "profile-empty"), { recursive: true });
    // Non-directory junk in the parent is ignored.
    await fs.writeFile(path.join(t3Home, T3_ANTIGRAVITY_REL, "readme.txt"), "no");

    const result = await discoverT3AntigravityBrainDirs({ home, env: {} });
    assert.deepEqual(result.brainDirs, [first.brainDir, second.brainDir].sort());
    assert.equal(result.reports.length, 1);
    assert.equal(result.reports[0].state, "ok");
    assert.equal(hostDiscoveryIncomplete(result.reports), false);
  });

  it("picks up a newly created profile on a later refresh", async () => {
    const home = await makeSandbox();
    const first = await writeBrain(t3HomeOf(home), "profile-aaa", "conv-1");
    const firstScan = await discoverT3AntigravityBrainDirs({ home, env: {} });
    assert.deepEqual(firstScan.brainDirs, [first.brainDir]);

    const second = await writeBrain(t3HomeOf(home), "profile-ccc", "conv-3");
    const secondScan = await discoverT3AntigravityBrainDirs({ home, env: {} });
    assert.deepEqual(secondScan.brainDirs, [first.brainDir, second.brainDir].sort());
  });

  it("reports an absent default parent without treating it as an error", async () => {
    const home = await makeSandbox();
    const result = await discoverT3AntigravityBrainDirs({ home, env: {} });
    assert.deepEqual(result.brainDirs, []);
    assert.equal(result.reports[0].state, "absent");
    assert.equal(hostDiscoveryIncomplete(result.reports), false);
    assert.deepEqual(formatAntigravityHostStatus(result.reports), []);
  });

  it("reports an empty parent that exists but has no readable profiles", async () => {
    const home = await makeSandbox();
    const parent = path.join(t3HomeOf(home), T3_ANTIGRAVITY_REL);
    await fs.mkdir(parent, { recursive: true });
    const result = await discoverT3AntigravityBrainDirs({ home, env: {} });
    assert.deepEqual(result.brainDirs, []);
    assert.equal(result.reports[0].state, "empty");
    assert.deepEqual(formatAntigravityHostStatus(result.reports), [`T3 parent empty (${parent})`]);
  });

  it("honors TOKENTRACKER_T3_HOME as the T3 state root", async () => {
    const home = await makeSandbox();
    const override = await makeSandbox();
    const found = await writeBrain(override, "profile-custom", "conv-1");
    // A default ~/.t3 tree in `home` must not be required or mixed in.
    const result = await discoverT3AntigravityBrainDirs({
      home,
      env: { TOKENTRACKER_T3_HOME: override },
    });
    assert.deepEqual(result.brainDirs, [found.brainDir]);
  });

  it("discovers additional search parents and dedupes overlapping aliases", async () => {
    const home = await makeSandbox();
    const extraRoot = await makeSandbox();
    const defaultFound = await writeBrain(t3HomeOf(home), "profile-default", "conv-1");
    const extraFound = await writeBrain(extraRoot, "profile-extra", "conv-2");
    const aliasParent = path.join(extraRoot, "alias-parent");
    await fs.symlink(
      path.join(extraRoot, T3_ANTIGRAVITY_REL),
      aliasParent,
    );

    const result = await discoverT3AntigravityBrainDirs({
      home,
      env: {},
      parents: [path.join(extraRoot, T3_ANTIGRAVITY_REL), aliasParent],
    });
    // Compare membership, not platform collation of random temporary paths.
    assert.deepEqual([...result.brainDirs].sort(), [defaultFound.brainDir, extraFound.brainDir].sort());
  });

  it("marks an unreadable parent incomplete, including when a known session lived there", async (t) => {
    const home = await makeSandbox();
    const found = await writeBrain(t3HomeOf(home), "profile-aaa", "conv-1");
    const parent = path.join(t3HomeOf(home), T3_ANTIGRAVITY_REL);
    // chmod does not revoke directory access on Windows (or for root).
    const readdir = fs.readdir;
    t.mock.method(fs, "readdir", async (target, ...args) => {
      if (path.resolve(target) === path.resolve(parent)) {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      }
      return readdir.call(fs, target, ...args);
    });

    const result = await discoverT3AntigravityBrainDirs({ home, env: {} });
    assert.deepEqual(result.brainDirs, []);
    assert.equal(result.reports[0].state, "unreadable");
    assert.equal(hostDiscoveryIncomplete(result.reports), true);
    assert.equal(
      hostDiscoveryIncomplete(
        [{ path: parent, state: "absent" }],
        new Set([found.transcript]),
      ),
      true,
    );
    const status = formatAntigravityHostStatus(result.reports);
    assert.match(status[0], /T3 parent unreadable/);
    assert.match(status[0], /EACCES|EPERM/);

  });
});

describe("listAntigravityTranscriptsWithStatus extra roots", () => {
  it("includes T3 transcripts alongside default gemini brain dirs without double-counting", async () => {
    const root = await makeSandbox();
    const geminiHome = path.join(root, ".gemini");
    const t3Home = path.join(root, "home");
    const geminiTranscript = path.join(
      geminiHome,
      "antigravity",
      "brain",
      "session-gemini",
      ".system_generated",
      "logs",
      "transcript.jsonl",
    );
    await fs.mkdir(path.dirname(geminiTranscript), { recursive: true });
    await fs.writeFile(geminiTranscript, "");
    const t3 = await writeBrain(t3HomeOf(t3Home), "profile-aaa", "conv-1");

    const host = await discoverT3AntigravityBrainDirs({ home: t3Home, env: {} });
    const inventory = await listAntigravityTranscriptsWithStatus(
      geminiHome,
      null,
      host.brainDirs,
    );
    assert.deepEqual(inventory.files.sort(), [geminiTranscript, t3.transcript].sort());
    assert.equal(inventory.complete, true);

    // Passing the same T3 brain dir twice must not duplicate the file.
    const duplicated = await listAntigravityTranscriptsWithStatus(
      geminiHome,
      null,
      [...host.brainDirs, t3.brainDir],
    );
    assert.deepEqual(duplicated.files.sort(), [geminiTranscript, t3.transcript].sort());
  });

  it("lets the existing incremental parser collect a discovered T3 transcript", async () => {
    const root = await makeSandbox();
    const line = {
      type: "PLANNER_RESPONSE",
      created_at: "2026-11-14T12:00:00.000Z",
      content: "hello from t3",
    };
    const t3 = await writeBrain(
      t3HomeOf(root),
      "profile-aaa",
      "conv-1",
      `${JSON.stringify(line)}\n`,
    );
    const host = await discoverT3AntigravityBrainDirs({ home: root, env: {} });
    const inventory = await listAntigravityTranscriptsWithStatus(null, null, host.brainDirs);
    assert.deepEqual(inventory.files, [t3.transcript]);

    const queuePath = path.join(root, "queue.jsonl");
    const cursors = { version: 1, files: {}, updatedAt: null };
    const result = await parseAntigravityIncremental({
      sessionFiles: inventory.files,
      cursors,
      queuePath,
    });
    assert.ok(result.eventsAggregated >= 1);
    assert.ok(cursors.files[t3.transcript]);
    const queued = (await fs.readFile(queuePath, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((row) => JSON.parse(row));
    assert.ok(queued.length >= 1);
    assert.equal(queued[0].source, "antigravity");
    assert.ok(queued[0].total_tokens > 0);
  });
});

describe("T3 discovery safety regressions", () => {
  it("marks profile stat failures and temporarily missing tracked profiles incomplete", async (t) => {
    const home = await makeSandbox();
    const missing = await writeBrain(t3HomeOf(home), "profile-missing", "old");
    const visible = await writeBrain(t3HomeOf(home), "profile-visible", "new");
    const stat = fs.stat;
    const mock = t.mock.method(fs, "stat", async (target, ...args) => {
      if (path.resolve(target) === path.resolve(missing.brainDir)) {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      }
      return stat.call(fs, target, ...args);
    });
    const denied = await discoverT3AntigravityBrainDirs({ home, env: {} });
    assert.deepEqual(denied.brainDirs, [visible.brainDir]);
    assert.equal(hostDiscoveryIncomplete(denied.reports, [missing.transcript]), true);
    mock.mock.restore();
    await fs.rm(path.dirname(missing.brainDir), { recursive: true });
    const disappeared = await discoverT3AntigravityBrainDirs({ home, env: {} });
    assert.equal(hostDiscoveryIncomplete(disappeared.reports, [missing.transcript]), true);
  });

  it("deduplicates native/T3 aliases while retaining the known cursor path", async () => {
    const home = await makeSandbox();
    const found = await writeBrain(t3HomeOf(home), "profile", "conv");
    const aliasRoot = path.join(home, "gemini-alias");
    await fs.symlink(found.brainDir, aliasRoot, process.platform === "win32" ? "junction" : "dir");
    const aliasFile = path.join(aliasRoot, path.relative(found.brainDir, found.transcript));
    assert.deepEqual(mergeAntigravityInventories([{ files: [found.transcript] }, { files: [aliasFile] }]), [found.transcript]);
    assert.deepEqual(mergeAntigravityInventories([{ files: [found.transcript] }, { files: [aliasFile] }], [aliasFile]), [aliasFile]);
  });

  it("honors wsl-only while still scanning explicitly supplied WSL parents", async () => {
    const home = await makeSandbox();
    await writeBrain(t3HomeOf(home), "native", "native");
    const wslHome = await makeSandbox();
    const wsl = await writeBrain(wslHome, "linux", "linux");
    const result = await discoverT3AntigravityBrainDirs({ home, platform: "win32",
      env: { TOKENTRACKER_WSL_MODE: "wsl-only" }, parents: [path.join(wslHome, T3_ANTIGRAVITY_REL)] });
    assert.deepEqual(result.brainDirs, [wsl.brainDir]);
    assert.equal(result.reports.length, 1);
    const none = await discoverT3AntigravityBrainDirs({ home, platform: "win32", env: { TOKENTRACKER_WSL_MODE: "wsl-only" } });
    assert.deepEqual(none.brainDirs, []);
  });
});

it("keeps a failed WSL T3 home probe incomplete when native profiles remain visible", async () => {
  const home = await makeSandbox();
  await writeBrain(t3HomeOf(home), "native", "visible");
  const native = await discoverT3AntigravityBrainDirs({ home, env: {} });
  const lostWsl = String.raw`\\wsl$\Ubuntu\home\user\.t3\userdata\providers\antigravity\profile\antigravity-acp\brain\old\.system_generated\logs\transcript.jsonl`;
  assert.equal(hostDiscoveryIncomplete(native.reports, [lostWsl]), true);
  assert.equal(hostDiscoveryIncomplete([], [lostWsl]), true);
  assert.equal(hostDiscoveryIncomplete(native.reports, []), false);
});
