"use strict";

// The credits sidecar is written by parseQoderNewIncremental, but cmdSync only
// invokes that parser when the projects dir lists at least one transcript. A
// user who deletes their last transcript therefore leaves the parser untouched
// and the dashboard keeps reporting the old total. These tests pin the sync
// wiring that publishes zero for that case — and only for that case.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { cmdSync } = require("../src/commands/sync");

const ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  "TOKENTRACKER_DEVICE_TOKEN",
  "TOKENTRACKER_INSFORGE_BASE_URL",
  "QODER_PROJECTS_DIR",
  "QODER_CN_PROJECTS_DIR",
  "QODER_DB_PATH",
  "QODER_HOME",
  "QODER_CN_DB_PATH",
  "QODER_CN_HOME",
];

async function withEnv(home, projectsDir, fn) {
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  try {
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    for (const key of ENV_KEYS.slice(2)) delete process.env[key];
    process.env.QODER_PROJECTS_DIR = projectsDir;
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function writeTranscript(filePath, id, credits) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const record = {
    type: "assistant",
    timestamp: "2026-09-10T08:00:00.000Z",
    uuid: id,
    sessionId: id,
    cwd: "/tmp/proj",
    message: {
      id,
      role: "assistant",
      model: "qfmodel",
      content: [{ type: "text", text: "ok" }],
      usage: {
        credits,
        original_credits: credits,
        billable: false,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  };
  fs.writeFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8");
}

function readSidecar(trackerDir, name = "qoder-credits.json") {
  const file = path.join(trackerDir, name);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

test("sync publishes zero credits once the last transcript is deleted", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-sync-qoder-credits-"));
  const projectsDir = path.join(home, "projects");
  const trackerDir = path.join(home, ".tokentracker", "tracker");
  try {
    await withEnv(home, projectsDir, async () => {
      const sessionFile = path.join(projectsDir, "proj", "sess-1.jsonl");
      writeTranscript(sessionFile, "s1", 5);
      await cmdSync(["--auto", "--source=qoder"]);
      assert.equal(readSidecar(trackerDir).total_credits, 5);

      fs.rmSync(sessionFile);
      await cmdSync(["--auto", "--source=qoder"]);
      assert.equal(
        readSidecar(trackerDir).total_credits,
        0,
        "an emptied projects dir must stop reporting the deleted install's spend",
      );
      assert.equal(readSidecar(trackerDir).record_count, 0);
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("an unreadable projects dir keeps the last proven credit total", async (t) => {
  // safeReadDir swallows a failed readdir and reports an empty tree, so a
  // directory that merely could not be listed looks exactly like one whose
  // transcripts were deleted. Zeroing on that reading would erase proven spend.
  if (
    process.platform === "win32"
    || (typeof process.getuid === "function" && process.getuid() === 0)
  ) {
    t.skip("permission bits are not enforced for this user/platform");
    return;
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-sync-qoder-unreadable-"));
  const projectsDir = path.join(home, "projects");
  const trackerDir = path.join(home, ".tokentracker", "tracker");
  try {
    await withEnv(home, projectsDir, async () => {
      writeTranscript(path.join(projectsDir, "proj", "sess-1.jsonl"), "s1", 5);
      await cmdSync(["--auto", "--source=qoder"]);
      assert.equal(readSidecar(trackerDir).total_credits, 5);

      fs.chmodSync(projectsDir, 0o000);
      try {
        await cmdSync(["--auto", "--source=qoder"]);
      } finally {
        fs.chmodSync(projectsDir, 0o755);
      }
      assert.equal(
        readSidecar(trackerDir).total_credits,
        5,
        "a failed directory listing is not evidence the transcripts are gone",
      );
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("sync leaves the sidecar untouched when the projects dir itself is gone", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-sync-qoder-absent-"));
  const projectsDir = path.join(home, "projects");
  const trackerDir = path.join(home, ".tokentracker", "tracker");
  try {
    await withEnv(home, projectsDir, async () => {
      writeTranscript(path.join(projectsDir, "proj", "sess-1.jsonl"), "s1", 5);
      await cmdSync(["--auto", "--source=qoder"]);
      assert.equal(readSidecar(trackerDir).total_credits, 5);

      // A missing dir is not an empty dir: the install may live on an
      // unmounted volume, and zeroing here would erase proven spend.
      fs.rmSync(projectsDir, { recursive: true, force: true });
      await cmdSync(["--auto", "--source=qoder"]);
      assert.equal(
        readSidecar(trackerDir).total_credits,
        5,
        "an unreadable/absent install keeps its last proven total",
      );
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
