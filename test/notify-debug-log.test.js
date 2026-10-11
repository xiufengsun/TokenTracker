const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");
const cp = require("node:child_process");
const { test } = require("node:test");
const { publicAnonFor } = require("./helpers/public-instance-fixture");

async function runNotify(notifyPath, env) {
  await new Promise((resolve, reject) => {
    const child = cp.execFile(process.execPath, [notifyPath, "--source=codex"], { env }, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

async function runInit(env) {
  const root = path.resolve(__dirname, "..");
  const entry = path.join(root, "bin", "tracker.js");

  await new Promise((resolve, reject) => {
    cp.execFile(
      process.execPath,
      [entry, "init", "--yes", "--no-auth", "--no-open", "--base-url", "https://example.invalid", "--anon-key", publicAnonFor("notify")],
      { env },
      (err) => {
        if (err) return reject(err);
        resolve();
      },
    );
  });
}

async function rmWithRetry(target, retries = 3) {
  let lastErr = null;
  for (let i = 0; i <= retries; i++) {
    try {
      await fs.rm(target, { recursive: true, force: true });
      return;
    } catch (err) {
      lastErr = err;
      if (!err || err.code !== "ENOTEMPTY") throw err;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw lastErr;
}

async function setupInitEnv() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-notify-debug-"));
  const codexHome = path.join(tmp, ".codex");
  await fs.mkdir(codexHome, { recursive: true });

  const env = {
    ...process.env,
    HOME: tmp,
    USERPROFILE: tmp,
    CODEX_HOME: codexHome,
    OPENCODE_CONFIG_DIR: path.join(tmp, ".config", "opencode"),
  };
  delete env.TOKENTRACKER_DEVICE_TOKEN;

  await runInit(env);

  const notifyPath = path.join(tmp, ".tokentracker", "bin", "notify.cjs");
  const trackerDir = path.join(tmp, ".tokentracker", "tracker");
  const debugLogPath = path.join(trackerDir, "notify.debug.jsonl");
  await fs.mkdir(trackerDir, { recursive: true });
  await fs.writeFile(path.join(trackerDir, "config.json"), "{}", "utf8");

  return {
    tmp,
    env,
    notifyPath,
    trackerDir,
    debugLogPath,
    cleanup: async () => {
      await rmWithRetry(tmp);
    },
  };
}

test("notify debug log is gated and capped by env settings", async () => {
  const gatedContext = await setupInitEnv();
  try {
    await assert.rejects(fs.stat(gatedContext.debugLogPath), /ENOENT/);
    await runNotify(gatedContext.notifyPath, gatedContext.env);
    await assert.rejects(fs.stat(gatedContext.debugLogPath), /ENOENT/);
  } finally {
    await gatedContext.cleanup();
  }

  const cappedContext = await setupInitEnv();
  try {
    const env = {
      ...cappedContext.env,
      TOKENTRACKER_NOTIFY_DEBUG: "1",
      TOKENTRACKER_NOTIFY_DEBUG_MAX_BYTES: "64",
    };

    await runNotify(cappedContext.notifyPath, env);
    const first = await fs.readFile(cappedContext.debugLogPath, "utf8");
    assert.ok(first.length > 0);

    const limit = 64;
    const filler = "x".repeat(limit);
    await fs.writeFile(cappedContext.debugLogPath, filler, "utf8");
    await runNotify(cappedContext.notifyPath, env);
    const after = await fs.readFile(cappedContext.debugLogPath, "utf8");
    assert.equal(after, filler);
  } finally {
    await cappedContext.cleanup();
  }
});
