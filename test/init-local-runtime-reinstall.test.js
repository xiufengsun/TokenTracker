const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");
const { spawn, spawnSync } = require("node:child_process");
const http = require("node:http");
const { test } = require("node:test");
const { installLocalTrackerApp } = require("../src/commands/init");

const repoRoot = path.join(__dirname, "..");

function runTracker(args, env) {
  return spawnSync(process.execPath, [path.join(repoRoot, "bin", "tracker.js"), ...args], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
  });
}

function runLocalTracker(trackerBinPath, args, env) {
  return spawnSync(process.execPath, [trackerBinPath, ...args], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
  });
}

test("init first sync keeps local data and credentials without uploading when not opted in", async (t) => {
  let uploads = 0;
  const server = http.createServer((_req, res) => {
    uploads += 1;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ inserted: 1, skipped: 0 }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  for (const enabled of [null, false]) {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-init-cloud-off-"));
    try {
      const trackerDir = path.join(tmp, ".tokentracker", "tracker");
      await fs.mkdir(trackerDir, { recursive: true });
      const prefPath = path.join(trackerDir, "cloud-sync-pref.json");
      if (enabled !== null) await fs.writeFile(prefPath, JSON.stringify({ enabled }));
      await fs.writeFile(path.join(trackerDir, "config.json"), JSON.stringify({ deviceToken: "fixture-token" }));
      const row = { source: "fixture", model: "fixture-model", hour_start: "2026-10-01T00:00:00Z", input_tokens: 20, output_tokens: 0, total_tokens: 20 };
      await fs.writeFile(path.join(trackerDir, "queue.jsonl"), JSON.stringify(row) + "\n");
      const env = {
        ...process.env, HOME: tmp, USERPROFILE: tmp, CODEX_HOME: path.join(tmp, ".codex"),
        OPENCODE_CONFIG_DIR: path.join(tmp, ".config", "opencode"),
      };
      delete env.TOKENTRACKER_SKIP_FIRST_SYNC;
      delete env.TOKENTRACKER_LOCAL_SYNC_ATTEMPT_ID;
      const result = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [path.join(repoRoot, "bin", "tracker.js"), "init", "--yes", "--no-auth", "--no-open", "--base-url", `http://127.0.0.1:${server.address().port}`], { cwd: repoRoot, env });
        let output = "";
        child.stdout.on("data", (chunk) => { output += chunk; });
        child.stderr.on("data", (chunk) => { output += chunk; });
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, output }));
      });
      assert.equal(result.code, 0, result.output);
      assert.equal(uploads, 0, "initial local collection must not imply cloud opt-in");
      assert.match(await fs.readFile(path.join(trackerDir, "queue.jsonl"), "utf8"), /"total_tokens":20/);
      assert.equal(JSON.parse(await fs.readFile(path.join(trackerDir, "config.json"), "utf8")).deviceToken, "fixture-token");
      assert.equal(await fs.readFile(prefPath, "utf8").catch(() => null), enabled === null ? null : JSON.stringify({ enabled }));
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }
});

test("init can rerun from installed local runtime without self-deleting app source", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-init-local-runtime-"));
  const env = {
    ...process.env,
    HOME: tmp,
    USERPROFILE: tmp,
    CODEX_HOME: path.join(tmp, ".codex"),
    OPENCODE_CONFIG_DIR: path.join(tmp, ".config", "opencode"),
  };
  delete env.TOKENTRACKER_DEVICE_TOKEN;

  try {
    await fs.mkdir(env.CODEX_HOME, { recursive: true });
    await fs.writeFile(path.join(env.CODEX_HOME, "config.toml"), "# empty\n", "utf8");

    const firstInit = runTracker(
      ["init", "--yes", "--no-auth", "--no-open", "--base-url", "https://example.invalid"],
      env,
    );
    assert.equal(
      firstInit.status,
      0,
      `expected first init to succeed\nstdout:\n${firstInit.stdout}\nstderr:\n${firstInit.stderr}`,
    );

    const trackerBinPath = path.join(tmp, ".tokentracker", "tracker", "app", "bin", "tracker.js");
    await fs.stat(trackerBinPath);

    const secondInit = runLocalTracker(
      trackerBinPath,
      ["init", "--yes", "--no-auth", "--no-open", "--base-url", "https://example.invalid"],
      env,
    );
    assert.equal(
      secondInit.status,
      0,
      `expected local runtime init to succeed\nstdout:\n${secondInit.stdout}\nstderr:\n${secondInit.stderr}`,
    );

    await fs.stat(path.join(tmp, ".tokentracker", "tracker", "app", "src", "commands", "init.js"));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("installLocalTrackerApp replaces stale installed runtime and writes a package marker", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-runtime-refresh-"));
  try {
    const appDir = path.join(tmp, "app");
    await fs.mkdir(path.join(appDir, "src", "lib"), { recursive: true });
    await fs.mkdir(path.join(appDir, "bin"), { recursive: true });
    await fs.writeFile(path.join(appDir, "src", "lib", "cursor-config.js"), "stale parser\n", "utf8");
    await fs.writeFile(path.join(appDir, "bin", "tracker.js"), "stale bin\n", "utf8");

    await installLocalTrackerApp({ appDir });

    const copiedParser = await fs.readFile(path.join(appDir, "src", "lib", "cursor-config.js"), "utf8");
    const marker = JSON.parse(await fs.readFile(path.join(appDir, "package.json"), "utf8"));
    assert.notEqual(copiedParser, "stale parser\n");
    assert.equal(marker.name, "tokentracker-cli");
    assert.equal(typeof marker.version, "string");
    await fs.stat(path.join(appDir, "src", "lib", "codex-context-breakdown.js"));
    await fs.stat(path.join(appDir, "dashboard", "dist", "index.html"));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
