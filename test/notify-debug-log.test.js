const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");
const cp = require("node:child_process");
const { test } = require("node:test");
const { buildNotifyHandler } = require("../src/commands/init");

async function runNotify(notifyPath, env) {
  await new Promise((resolve, reject) => {
    cp.execFile(
      process.execPath,
      [notifyPath, "--source=codex"],
      // notify.cjs exits immediately after a detached spawn; bound the wait so
      // a Windows handle leak cannot stall the suite.
      { env, timeout: 30_000, windowsHide: true },
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

async function setupNotifyEnv() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-notify-debug-"));
  const trackerDir = path.join(tmp, ".tokentracker", "tracker");
  const binDir = path.join(tmp, ".tokentracker", "bin");
  await fs.mkdir(trackerDir, { recursive: true });
  await fs.mkdir(binDir, { recursive: true });
  await fs.writeFile(path.join(trackerDir, "config.json"), "{}", "utf8");

  // Pre-seed throttle far in the future so every notify invocation in this
  // test skips detached sync/npx (20s window). Debug logging runs before the
  // throttle check, so assertions stay intact.
  await fs.writeFile(
    path.join(trackerDir, "sync.throttle"),
    String(Date.now() + 60 * 60 * 1000),
    "utf8",
  );

  const notifyPath = path.join(binDir, "notify.cjs");
  await fs.writeFile(notifyPath, buildNotifyHandler({ trackerDir }), "utf8");
  await fs.chmod(notifyPath, 0o755).catch(() => {});

  const debugLogPath = path.join(trackerDir, "notify.debug.jsonl");
  const env = {
    ...process.env,
    HOME: tmp,
    USERPROFILE: tmp,
  };
  delete env.TOKENTRACKER_DEVICE_TOKEN;
  delete env.TOKENTRACKER_NOTIFY_DEBUG;
  delete env.TOKENTRACKER_NOTIFY_DEBUG_MAX_BYTES;

  return {
    tmp,
    env,
    notifyPath,
    debugLogPath,
    cleanup: async () => {
      await rmWithRetry(tmp);
    },
  };
}

// Avoid the old full `tracker init` path (copies local runtime + dashboard
// dist twice). That regularly exceeded Windows CI's 120s budget under load.
test("notify debug log is gated and capped by env settings", { timeout: 60_000 }, async () => {
  const gatedContext = await setupNotifyEnv();
  try {
    await assert.rejects(fs.stat(gatedContext.debugLogPath), /ENOENT/);
    await runNotify(gatedContext.notifyPath, gatedContext.env);
    await assert.rejects(fs.stat(gatedContext.debugLogPath), /ENOENT/);
  } finally {
    await gatedContext.cleanup();
  }

  const cappedContext = await setupNotifyEnv();
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
