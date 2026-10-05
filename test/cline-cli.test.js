"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { cmdSync } = require("../src/commands/sync");
const { withHome } = require("./helpers/with-home");

test("Cline discovery failure preserves sync state and deleted files are pruned", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cline-sync-"));
  const restoreHome = withHome(home);
  const previousDir = process.env.TOKENTRACKER_CLINE_SESSIONS_DIR;
  const sessionsDir = path.join(home, "sessions");
  process.env.TOKENTRACKER_CLINE_SESSIONS_DIR = sessionsDir;
  try {
    const sessionDir = path.join(sessionsDir, "fixture");
    fs.mkdirSync(sessionDir, { recursive: true });
    const filePath = path.join(sessionDir, "fixture.messages.json");
    const transcript = JSON.stringify({ messages: [{
      id: "turn", role: "assistant", ts: Date.now(), metrics: { inputTokens: 100 },
    }] });
    fs.writeFileSync(filePath, transcript);
    const args = ["--auto", "--from-notify", "--source=cline"];
    await cmdSync(args);
    const trackerDir = path.join(home, ".tokentracker", "tracker");
    const cursorPath = path.join(trackerDir, "cursors.json");
    const readCursor = () => JSON.parse(fs.readFileSync(cursorPath, "utf8"));
    const before = readCursor();
    const queueBefore = fs.readFileSync(path.join(trackerDir, "queue.jsonl"), "utf8");
    for (const target of [sessionsDir, sessionDir]) {
      for (const code of ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "EIO"]) {
        const readDir = fs.readdirSync;
        const stat = fs.statSync;
        const failure = Object.assign(new Error("synthetic read failure"), { code });
        t.mock.method(fs, "readdirSync", (dir, ...options) => {
          if (dir === target) throw failure;
          return readDir(dir, ...options);
        });
        t.mock.method(fs, "statSync", (file, ...options) => {
          if (file === filePath) throw failure;
          return stat(file, ...options);
        });
        await cmdSync(args);
        assert.deepEqual(readCursor().cline.messageTotalsByFile, before.cline.messageTotalsByFile);
        assert.deepEqual(readCursor().cline.fileOffsets, before.cline.fileOffsets);
        assert.deepEqual(readCursor().hourly.buckets, before.hourly.buckets);
        assert.deepEqual(readCursor().hourly.groupQueued, before.hourly.groupQueued);
        assert.equal(fs.readFileSync(path.join(trackerDir, "queue.jsonl"), "utf8"), queueBefore);
        t.mock.restoreAll();
        await cmdSync(args);
        assert.equal(fs.readFileSync(path.join(trackerDir, "queue.jsonl"), "utf8"), queueBefore);
      }
    }

    // A missing sessions root is an incomplete scan, so its ledger must survive
    // until the root is readable again.
    fs.rmSync(sessionsDir, { recursive: true, force: true });
    await cmdSync(args);
    assert.deepEqual(readCursor().cline.messageTotalsByFile, before.cline.messageTotalsByFile);
    assert.deepEqual(readCursor().cline.fileOffsets, before.cline.fileOffsets);
    assert.equal(fs.readFileSync(path.join(trackerDir, "queue.jsonl"), "utf8"), queueBefore);

    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(filePath, transcript);
    await cmdSync(args);
    assert.equal(fs.readFileSync(path.join(trackerDir, "queue.jsonl"), "utf8"), queueBefore);

    fs.unlinkSync(filePath);
    await cmdSync(args);
    assert.deepEqual(readCursor().cline.fileOffsets, {});
    assert.deepEqual(readCursor().cline.messageTotalsByFile, {});
  } finally {
    t.mock.restoreAll();
    restoreHome();
    if (previousDir === undefined) delete process.env.TOKENTRACKER_CLINE_SESSIONS_DIR;
    else process.env.TOKENTRACKER_CLINE_SESSIONS_DIR = previousDir;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("Cline status exposes present and absent installs in JSON and light output", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cline-status-"));
  try {
    const sessionsDir = path.join(home, "sessions");
    const sessionDir = path.join(sessionsDir, "fixture");
    fs.mkdirSync(sessionDir, { recursive: true });
    const filePath = path.join(sessionDir, "fixture.messages.json");
    fs.writeFileSync(filePath, "[]");
    const run = (format) => {
      const result = spawnSync(process.execPath, [path.join(__dirname, "../bin/tracker.js"), "status", format], {
        encoding: "utf8",
        timeout: 30_000,
        env: { ...process.env, HOME: home, USERPROFILE: home, TOKENTRACKER_CLINE_SESSIONS_DIR: sessionsDir },
      });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout;
    };
    assert.deepEqual(JSON.parse(run("--json")).providers.cline, { installed: true, files: 1 });
    assert.match(run("--light"), /Provider · cline\s+\| installed, 1 file/);
    fs.unlinkSync(filePath);
    assert.deepEqual(JSON.parse(run("--json")).providers.cline, { installed: false });
    assert.match(run("--light"), /Provider · cline\s+\| not installed/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("Cline status and init report discovery failures and continue with other providers", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cline-status-error-"));
  const sessionsDir = path.join(home, "sessions");
  try {
    const sessionDir = path.join(sessionsDir, "readable");
    const unreadableDir = path.join(sessionsDir, "unreadable");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.mkdirSync(unreadableDir);
    fs.writeFileSync(path.join(sessionDir, "readable.messages.json"), "[]");
    for (const target of [sessionsDir, unreadableDir]) {
      const run = (command, args) => {
        const commandPath = path.join(__dirname, "..", "src", "commands", `${command}.js`);
        const script = `
          const fs = require("node:fs");
          const readDir = fs.readdirSync;
          fs.readdirSync = (dir, ...options) => {
            if (dir === ${JSON.stringify(target)}) {
              throw Object.assign(new Error("synthetic discovery failure"), { code: "EACCES" });
            }
            return readDir(dir, ...options);
          };
          require(${JSON.stringify(commandPath)})[${JSON.stringify(command === "status" ? "cmdStatus" : "cmdInit")}](${JSON.stringify(args)})
            .catch((error) => { console.error(error); process.exitCode = 1; });
        `;
        const result = spawnSync(process.execPath, ["-e", script], {
          encoding: "utf8",
          timeout: 30_000,
          env: {
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            HOME: home,
            USERPROFILE: home,
            TOKENTRACKER_CLINE_SESSIONS_DIR: sessionsDir,
            TOKENTRACKER_WSL_MODE: "native-only",
            TOKENTRACKER_SKIP_LOCAL_RUNTIME_COPY: "1",
            TOKENTRACKER_SKIP_FIRST_SYNC: "1",
            TOKENTRACKER_SKIP_OPENCLAW_CLI: "1",
          },
        });
        assert.equal(result.status, 0, result.stderr);
        return result.stdout;
      };
      const summary = JSON.parse(run("status", ["--json"]));
      assert.equal(summary.providers.cline.installed, target !== sessionsDir);
      if (target !== sessionsDir) assert.equal(summary.providers.cline.files, 1);
      assert.match(summary.providers.cline.error, /EACCES/);
      assert.ok(summary.providers.zed, "other providers remain in the report");
      assert.match(run("status", ["--light"]), /Provider · cline[^\n]*EACCES/);
      assert.match(run("status", []), /Cline: .*discovery failed[^\n]*EACCES/);
      const init = run("init", ["--yes", "--no-auth", "--no-open"]);
      assert.match(init, /Local configuration complete/);
      assert.match(init, /Cline[^\n]*discovery failed[^\n]*EACCES/);
      if (target !== sessionsDir) assert.match(init, /Cline[^\n]*transcript/);
      assert.match(init, /Every Code/, "init continues past Cline to later integrations");
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
