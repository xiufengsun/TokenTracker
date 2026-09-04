const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");
const { test } = require("node:test");

// These tests only exercise hook/config/notify wiring, never the copied runtime
// or a real first sync. Skip both so each cmdInit doesn't copy ~10 MB and spawn
// a `sync --drain` subprocess — that dominated the suite's wall time.
process.env.TOKENTRACKER_SKIP_LOCAL_RUNTIME_COPY = "1";
process.env.TOKENTRACKER_SKIP_FIRST_SYNC = "1";
process.env.TOKENTRACKER_SKIP_OPENCLAW_CLI = "1";

const {
  cmdInit,
  buildNotifyHandler,
  repairCodexNotifyIntegration,
  repairRuntimeIntegrations,
} = require("../src/commands/init");
const { cmdUninstall } = require("../src/commands/uninstall");
const { withHome } = require("./helpers/with-home");
const { buildClaudeHookCommand } = require("../src/lib/claude-config");
const { buildGeminiHookCommand } = require("../src/lib/gemini-config");
const {
  buildOpencodePlugin,
  DEFAULT_EVENT,
  DEFAULT_PLUGIN_NAME,
  PLUGIN_MARKER,
} = require("../src/lib/opencode-config");
const { GROK_HOOK_FILENAME } = require("../src/lib/grok-hook");

async function waitForFile(filePath, { timeoutMs = 1500, intervalMs = 50 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      return await fs.readFile(filePath, "utf8");
    } catch (err) {
      if (err?.code !== "ENOENT") throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return null;
}

function flattenHookEntries(entries) {
  return entries.flatMap((entry) => (Array.isArray(entry?.hooks) ? entry.hooks : [entry]));
}

test("notify handler hides detached background sync windows on Windows", () => {
  const source = buildNotifyHandler({
    trackerDir: path.join(os.tmpdir(), "tokentracker-notify-windows-hide"),
    packageName: "tokentracker-cli",
  });

  assert.match(
    source,
    /cp\.spawn\(argv\[0\], argv\.slice\(1\), \{[\s\S]*?detached: true,[\s\S]*?windowsHide: true,[\s\S]*?stdio: 'ignore'/,
  );
});

async function runGeneratedNotifyHandler({
  trackerDir,
  notify,
  args = ["--source=codex", "turn-ended"],
  originalSource = "codex",
}) {
  await fs.mkdir(trackerDir, { recursive: true });
  const notifyPath = path.join(trackerDir, "notify.cjs");
  await fs.writeFile(
    notifyPath,
    buildNotifyHandler({ trackerDir, packageName: "tokentracker-cli" }),
    "utf8",
  );
  await fs.chmod(notifyPath, 0o755);
  await fs.writeFile(
    path.join(
      trackerDir,
      originalSource === "acode" ? "acode_notify_original.json" : "codex_notify_original.json",
    ),
    JSON.stringify({ notify, capturedAt: new Date().toISOString() }),
    "utf8",
  );
  await new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.TOKENTRACKER_DEVICE_TOKEN;
    const child = require("node:child_process").execFile(
      process.execPath,
      [notifyPath, ...args],
      { env },
      (err) => (err ? reject(err) : resolve()),
    );
    child.stdin?.end();
  });
}

test("notify handler runs local source sync without a cloud device token", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-notify-local-sync-"));
  try {
    const trackerDir = path.join(tmp, "tracker");
    const trackerBinPath = path.join(trackerDir, "app", "bin", "tracker.js");
    const markerPath = path.join(tmp, "sync-args.json");
    const notifyPath = path.join(tmp, "notify.cjs");
    await fs.mkdir(path.dirname(trackerBinPath), { recursive: true });
    await fs.writeFile(
      trackerBinPath,
      `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify(process.argv.slice(2)));\n`,
      "utf8",
    );
    await fs.writeFile(
      notifyPath,
      buildNotifyHandler({ trackerDir, packageName: "tokentracker-cli" }),
      "utf8",
    );

    const env = { ...process.env };
    delete env.TOKENTRACKER_DEVICE_TOKEN;
    await new Promise((resolve, reject) => {
      require("node:child_process").execFile(
        process.execPath,
        [notifyPath, "--source=codex", "turn-ended"],
        { env },
        (err) => (err ? reject(err) : resolve()),
      );
    });

    const marker = await waitForFile(markerPath, { timeoutMs: 5000 });
    assert.deepEqual(JSON.parse(marker), ["sync", "--auto", "--from-notify", "--source", "codex"]);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("notify handler chains executable original notify commands and skips stale explicit paths", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-notify-chain-"));
  try {
    const markerPath = path.join(tmp, "unsafe-marker");
    const skyDir = path.join(
      tmp,
      ".codex",
      "plugins",
      "cache",
      "openai-bundled",
      "computer-use",
      "1.0.750",
      "Codex Computer Use.app",
      "Contents",
      "SharedSupport",
      "SkyComputerUseClient.app",
      "Contents",
      "MacOS",
    );
    const skyPath = path.join(skyDir, "SkyComputerUseClient");
    await fs.mkdir(skyDir, { recursive: true });
    await fs.writeFile(
      skyPath,
      `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'ran');\n`,
      "utf8",
    );
    await fs.chmod(skyPath, 0o755);

    await runGeneratedNotifyHandler({
      trackerDir: path.join(tmp, "tracker-sky"),
      notify: [skyPath, "turn-ended"],
    });
    assert.equal(await waitForFile(markerPath, { timeoutMs: 5000 }), "ran");

    await runGeneratedNotifyHandler({
      trackerDir: path.join(tmp, "tracker-missing"),
      notify: [path.join(tmp, "missing-notify"), "turn-ended"],
    });
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("notify handler skips an original notify that nests itself", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-notify-chain-"));
  try {
    const trackerDir = path.join(tmp, "tracker");
    await fs.mkdir(trackerDir, { recursive: true });
    const notifyPath = path.join(await fs.realpath(trackerDir), "notify.cjs");
    const markerPath = path.join(tmp, "sky-marker");
    const skyPath = path.join(tmp, "SkyComputerUseClient");
    await fs.writeFile(
      skyPath,
      `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'ran');\n`,
      "utf8",
    );
    await fs.chmod(skyPath, 0o755);

    await runGeneratedNotifyHandler({
      trackerDir,
      notify: [
        skyPath,
        "turn-ended",
        "--previous-notify",
        JSON.stringify(["/usr/bin/env", "node", notifyPath]),
      ],
    });

    assert.equal(await waitForFile(markerPath, { timeoutMs: 500 }), null);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("notify handler skips a nested self notify referenced through a symlinked path", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-notify-chain-"));
  try {
    const trackerDir = path.join(tmp, "tracker");
    await fs.mkdir(trackerDir, { recursive: true });
    const linkDir = path.join(tmp, "tracker-link");
    await fs.symlink(trackerDir, linkDir, "dir");
    const notifyPath = path.join(linkDir, "notify.cjs");
    const markerPath = path.join(tmp, "sky-marker");
    const skyPath = path.join(tmp, "SkyComputerUseClient");
    await fs.writeFile(
      skyPath,
      `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'ran');\n`,
      "utf8",
    );
    await fs.chmod(skyPath, 0o755);

    await runGeneratedNotifyHandler({
      trackerDir,
      notify: [
        skyPath,
        "turn-ended",
        "--previous-notify",
        JSON.stringify(["/usr/bin/env", "node", notifyPath]),
      ],
    });

    assert.equal(await waitForFile(markerPath, { timeoutMs: 1500 }), null);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("notify handler skips a stale nested notify pointing into a .tokentracker dir", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-notify-chain-"));
  try {
    const trackerDir = path.join(tmp, "tracker");
    const staleNotifyPath = path.join(tmp, ".tokentracker", "bin", "notify.cjs");
    const markerPath = path.join(tmp, "sky-marker");
    const skyPath = path.join(tmp, "SkyComputerUseClient");
    await fs.mkdir(trackerDir, { recursive: true });
    await fs.writeFile(
      skyPath,
      `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'ran');\n`,
      "utf8",
    );
    await fs.chmod(skyPath, 0o755);

    await runGeneratedNotifyHandler({
      trackerDir,
      notify: [
        skyPath,
        "turn-ended",
        "--previous-notify",
        JSON.stringify(["/usr/bin/env", "node", staleNotifyPath]),
      ],
    });

    assert.equal(await waitForFile(markerPath, { timeoutMs: 1500 }), null);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("notify handler avoids duplicating existing payload args when chaining", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-notify-chain-"));
  try {
    const markerPath = path.join(tmp, "dedupe-marker");
    const shimPath = path.join(tmp, "dedupe-notify.js");
    await fs.writeFile(
      shimPath,
      `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, process.argv.slice(2).join('|'));\n`,
      "utf8",
    );

    await runGeneratedNotifyHandler({
      trackerDir: path.join(tmp, "tracker-dedupe"),
      notify: [process.execPath, shimPath, "turn-ended"],
    });

    const marker = await waitForFile(markerPath, { timeoutMs: 5000 });
    assert.equal(marker, "turn-ended");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("notify handler skips interpreter original notify when script target is missing", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-notify-chain-"));
  try {
    const markerPath = path.join(tmp, "missing-script-marker");
    const fakeNodePath = path.join(tmp, "node");
    const missingScriptPath = path.join(tmp, "missing-notify.js");
    await fs.writeFile(
      fakeNodePath,
      `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(markerPath)}, process.argv.slice(2).join('|'));\n`,
      "utf8",
    );
    await fs.chmod(fakeNodePath, 0o755);

    await runGeneratedNotifyHandler({
      trackerDir: path.join(tmp, "tracker-missing-script"),
      notify: [fakeNodePath, missingScriptPath, "turn-ended"],
    });

    assert.equal(await waitForFile(markerPath), null);

    await runGeneratedNotifyHandler({
      trackerDir: path.join(tmp, "tracker-missing-env-script"),
      notify: ["/usr/bin/env", fakeNodePath, missingScriptPath, "turn-ended"],
    });

    assert.equal(await waitForFile(markerPath), null);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("notify handler skips node-like original notify without a script target", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-notify-chain-"));
  try {
    const markerPath = path.join(tmp, "missing-target-marker");
    const fakeNodePath = path.join(tmp, "node");
    await fs.writeFile(
      fakeNodePath,
      `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(markerPath)}, process.argv.slice(2).join('|'));\n`,
      "utf8",
    );
    await fs.chmod(fakeNodePath, 0o755);

    await runGeneratedNotifyHandler({
      trackerDir: path.join(tmp, "tracker-node-no-target"),
      notify: [fakeNodePath],
    });
    assert.equal(await waitForFile(markerPath), null);

    await runGeneratedNotifyHandler({
      trackerDir: path.join(tmp, "tracker-env-node-no-target"),
      notify: ["/usr/bin/env", fakeNodePath],
    });
    assert.equal(await waitForFile(markerPath), null);

    await runGeneratedNotifyHandler({
      trackerDir: path.join(tmp, "tracker-node-payload-token"),
      notify: [fakeNodePath, "turn-ended"],
    });
    assert.equal(await waitForFile(markerPath), null);

    await runGeneratedNotifyHandler({
      trackerDir: path.join(tmp, "tracker-env-node-payload-token"),
      notify: ["/usr/bin/env", fakeNodePath, "turn-ended"],
    });
    assert.equal(await waitForFile(markerPath), null);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("notify handler validates env split-string interpreter targets", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-notify-chain-"));
  try {
    const markerPath = path.join(tmp, "env-split-marker");
    const fakeEnvPath = path.join(tmp, "env");
    const fakeNodePath = path.join(tmp, "node");
    const explicitScriptPath = path.join(tmp, "notify-script.js");
    await fs.writeFile(
      fakeEnvPath,
      `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(markerPath)}, process.argv.slice(2).join('|'));\n`,
      "utf8",
    );
    await fs.chmod(fakeEnvPath, 0o755);
    await fs.writeFile(fakeNodePath, "// readable node executable placeholder\n", "utf8");
    await fs.writeFile(explicitScriptPath, "// readable notify script\n", "utf8");

    for (const optionNotify of [
      [fakeEnvPath, "-C", tmp, fakeNodePath, "turn-ended"],
      [fakeEnvPath, "-P", tmp, fakeNodePath, "turn-ended"],
      [fakeEnvPath, "--chdir", tmp, fakeNodePath, "turn-ended"],
      [fakeEnvPath, `--chdir=${tmp}`, fakeNodePath, "turn-ended"],
      [fakeEnvPath, "--path", tmp, fakeNodePath, "turn-ended"],
      [fakeEnvPath, `--path=${tmp}`, fakeNodePath, "turn-ended"],
    ]) {
      await runGeneratedNotifyHandler({
        trackerDir: path.join(tmp, `tracker-env-option-payload-token-${optionNotify[1].replace(/[^A-Za-z0-9]/g, "-")}`),
        notify: optionNotify,
      });
      assert.equal(await waitForFile(markerPath, { timeoutMs: 500 }), null);
    }

    await runGeneratedNotifyHandler({
      trackerDir: path.join(tmp, "tracker-env-value-option-explicit-script"),
      notify: [fakeEnvPath, "-C", tmp, fakeNodePath, explicitScriptPath],
    });
    assert.equal(
      await waitForFile(markerPath, { timeoutMs: 5000 }),
      `-C|${tmp}|${fakeNodePath}|${explicitScriptPath}|turn-ended`,
    );
    await fs.rm(markerPath, { force: true });

    const chdirDir = path.join(tmp, "env-chdir");
    const relativeScriptName = "relative-notify.js";
    const relativeScriptPath = path.join(chdirDir, relativeScriptName);
    await fs.mkdir(chdirDir);
    await fs.writeFile(relativeScriptPath, "// readable relative notify script\n", "utf8");

    await runGeneratedNotifyHandler({
      trackerDir: path.join(tmp, "tracker-env-chdir-relative-explicit-script"),
      notify: [fakeEnvPath, "--chdir", chdirDir, fakeNodePath, `./${relativeScriptName}`],
    });
    assert.equal(
      await waitForFile(markerPath, { timeoutMs: 5000 }),
      `--chdir|${chdirDir}|${fakeNodePath}|./${relativeScriptName}|turn-ended`,
    );
    await fs.rm(markerPath, { force: true });

    await runGeneratedNotifyHandler({
      trackerDir: path.join(tmp, "tracker-env-chdir-relative-missing-script"),
      notify: [fakeEnvPath, "--chdir", tmp, fakeNodePath, `./${relativeScriptName}`],
    });
    assert.equal(await waitForFile(markerPath, { timeoutMs: 500 }), null);

    await runGeneratedNotifyHandler({
      trackerDir: path.join(tmp, "tracker-env-chdir-generic-relative-missing-command"),
      notify: [fakeEnvPath, "--chdir", tmp, "./missing-generic-notify.sh"],
    });
    assert.equal(await waitForFile(markerPath, { timeoutMs: 500 }), null);

    await runGeneratedNotifyHandler({
      trackerDir: path.join(tmp, "tracker-env-short-chdir-generic-relative-missing-command"),
      notify: [fakeEnvPath, "-C", tmp, "./missing-generic-notify.sh"],
    });
    assert.equal(await waitForFile(markerPath, { timeoutMs: 500 }), null);

    await runGeneratedNotifyHandler({
      trackerDir: path.join(tmp, "tracker-env-unknown-option-explicit-script"),
      notify: [fakeEnvPath, "--unknown-option", fakeNodePath, explicitScriptPath],
    });
    assert.equal(await waitForFile(markerPath, { timeoutMs: 500 }), null);

    await runGeneratedNotifyHandler({
      trackerDir: path.join(tmp, "tracker-env-split-payload-token"),
      notify: [fakeEnvPath, "-S", `${fakeNodePath} turn-ended`],
    });
    assert.equal(await waitForFile(markerPath, { timeoutMs: 500 }), null);

    await runGeneratedNotifyHandler({
      trackerDir: path.join(tmp, "tracker-env-long-split-payload-token"),
      notify: [fakeEnvPath, "--split-string", `${fakeNodePath} turn-ended`],
    });
    assert.equal(await waitForFile(markerPath, { timeoutMs: 500 }), null);

    await runGeneratedNotifyHandler({
      trackerDir: path.join(tmp, "tracker-env-split-assignment-payload-token"),
      notify: [fakeEnvPath, "-S", `TOKENTRACKER_TEST=1 ${fakeNodePath} turn-ended`],
    });
    assert.equal(await waitForFile(markerPath, { timeoutMs: 500 }), null);

    await runGeneratedNotifyHandler({
      trackerDir: path.join(tmp, "tracker-env-split-double-dash-payload-token"),
      notify: [fakeEnvPath, "-S", `-- ${fakeNodePath} turn-ended`],
    });
    assert.equal(await waitForFile(markerPath, { timeoutMs: 500 }), null);

    await runGeneratedNotifyHandler({
      trackerDir: path.join(tmp, "tracker-env-double-dash-assignment-payload-token"),
      notify: [fakeEnvPath, "--", "TOKENTRACKER_TEST=1", fakeNodePath, "turn-ended"],
    });
    assert.equal(await waitForFile(markerPath, { timeoutMs: 500 }), null);

    await runGeneratedNotifyHandler({
      trackerDir: path.join(tmp, "tracker-env-split-double-dash-assignment-payload-token"),
      notify: [fakeEnvPath, "-S", `-- TOKENTRACKER_TEST=1 ${fakeNodePath} turn-ended`],
    });
    assert.equal(await waitForFile(markerPath, { timeoutMs: 500 }), null);

    await runGeneratedNotifyHandler({
      trackerDir: path.join(tmp, "tracker-env-split-explicit-script"),
      notify: [fakeEnvPath, "-S", `${fakeNodePath} ${explicitScriptPath}`],
    });
    assert.equal(
      await waitForFile(markerPath, { timeoutMs: 5000 }),
      `-S|${fakeNodePath} ${explicitScriptPath}|turn-ended`,
    );
    await fs.rm(markerPath, { force: true });

    await runGeneratedNotifyHandler({
      trackerDir: path.join(tmp, "tracker-env-long-split-explicit-script"),
      notify: [fakeEnvPath, `--split-string=${fakeNodePath} ${explicitScriptPath}`],
    });
    assert.equal(
      await waitForFile(markerPath, { timeoutMs: 5000 }),
      `--split-string=${fakeNodePath} ${explicitScriptPath}|turn-ended`,
    );
    await fs.rm(markerPath, { force: true });

    await runGeneratedNotifyHandler({
      trackerDir: path.join(tmp, "tracker-env-split-assignment-explicit-script"),
      notify: [fakeEnvPath, "-S", `TOKENTRACKER_TEST=1 ${fakeNodePath} ${explicitScriptPath}`],
    });
    assert.equal(
      await waitForFile(markerPath, { timeoutMs: 5000 }),
      `-S|TOKENTRACKER_TEST=1 ${fakeNodePath} ${explicitScriptPath}|turn-ended`,
    );
    await fs.rm(markerPath, { force: true });

    await runGeneratedNotifyHandler({
      trackerDir: path.join(tmp, "tracker-env-double-dash-assignment-explicit-script"),
      notify: [fakeEnvPath, "--", "TOKENTRACKER_TEST=1", fakeNodePath, explicitScriptPath],
    });
    assert.equal(
      await waitForFile(markerPath, { timeoutMs: 5000 }),
      `--|TOKENTRACKER_TEST=1|${fakeNodePath}|${explicitScriptPath}|turn-ended`,
    );
    await fs.rm(markerPath, { force: true });

    await runGeneratedNotifyHandler({
      trackerDir: path.join(tmp, "tracker-env-split-double-dash-assignment-explicit-script"),
      notify: [fakeEnvPath, "-S", `-- TOKENTRACKER_TEST=1 ${fakeNodePath} ${explicitScriptPath}`],
    });
    assert.equal(
      await waitForFile(markerPath, { timeoutMs: 5000 }),
      `-S|-- TOKENTRACKER_TEST=1 ${fakeNodePath} ${explicitScriptPath}|turn-ended`,
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("notify handler treats exe-suffixed runtimes as node-like interpreters", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-notify-chain-"));
  try {
    for (const runtimeName of ["node", "bun", "deno"]) {
      const markerPath = path.join(tmp, `${runtimeName}-exe-marker`);
      const fakeRuntimePath = path.join(tmp, `${runtimeName}.exe`);
      const explicitScriptPath = path.join(tmp, `${runtimeName}-notify.js`);
      await fs.writeFile(
        fakeRuntimePath,
        `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(markerPath)}, process.argv.slice(2).join('|'));\n`,
        "utf8",
      );
      await fs.chmod(fakeRuntimePath, 0o755);
      await fs.writeFile(explicitScriptPath, "// readable notify script\n", "utf8");

      const explicitNotify =
        runtimeName === "node"
          ? [fakeRuntimePath, explicitScriptPath, "turn-ended"]
          : [fakeRuntimePath, "run", explicitScriptPath, "turn-ended"];
      await runGeneratedNotifyHandler({
        trackerDir: path.join(tmp, `tracker-${runtimeName}-exe-explicit-script`),
        notify: explicitNotify,
      });
      assert.match(
        await waitForFile(markerPath, { timeoutMs: 5000 }),
        new RegExp(`${explicitScriptPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\|turn-ended`),
      );
      await fs.rm(markerPath, { force: true });

      const payloadNotify =
        runtimeName === "node"
          ? [fakeRuntimePath, "turn-ended"]
          : [fakeRuntimePath, "run", "turn-ended"];
      await runGeneratedNotifyHandler({
        trackerDir: path.join(tmp, `tracker-${runtimeName}-exe-payload-token`),
        notify: payloadNotify,
      });
      assert.equal(await waitForFile(markerPath, { timeoutMs: 500 }), null);
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("notify handler skips bun and deno original notify when payload token is not a script", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-notify-chain-"));
  try {
    for (const runtimeName of ["bun", "deno"]) {
      const markerPath = path.join(tmp, `${runtimeName}-payload-marker`);
      const fakeRuntimePath = path.join(tmp, runtimeName);
      const explicitScriptPath = path.join(tmp, `${runtimeName}-notify.js`);
      const lockFilePath = path.join(tmp, `${runtimeName}-lock.json`);
      await fs.writeFile(
        fakeRuntimePath,
        `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(markerPath)}, process.argv.slice(2).join('|'));\n`,
        "utf8",
      );
      await fs.chmod(fakeRuntimePath, 0o755);
      await fs.writeFile(explicitScriptPath, "// readable notify script\n", "utf8");
      await fs.writeFile(lockFilePath, "{}\n", "utf8");

      await runGeneratedNotifyHandler({
        trackerDir: path.join(tmp, `tracker-${runtimeName}-run-explicit-script`),
        notify: [fakeRuntimePath, "run", explicitScriptPath, "turn-ended"],
      });
      assert.match(
        await waitForFile(markerPath, { timeoutMs: 5000 }),
        new RegExp(`^run\\|${explicitScriptPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\|turn-ended`),
      );
      await fs.rm(markerPath, { force: true });

      const valueOptionNotify =
        runtimeName === "bun"
          ? [fakeRuntimePath, "run", "--cwd", tmp, explicitScriptPath, "turn-ended"]
          : [fakeRuntimePath, "run", "--preload", explicitScriptPath, explicitScriptPath, "turn-ended"];
      await runGeneratedNotifyHandler({
        trackerDir: path.join(tmp, `tracker-${runtimeName}-run-value-option-explicit-script`),
        notify: valueOptionNotify,
      });
      assert.match(
        await waitForFile(markerPath, { timeoutMs: 5000 }),
        new RegExp(`${explicitScriptPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\|turn-ended$`),
      );
      await fs.rm(markerPath, { force: true });

      if (runtimeName === "bun") {
        const bunCwdDir = path.join(tmp, "bun-cwd");
        const relativeBunScript = "relative-bun-notify.js";
        await fs.mkdir(bunCwdDir, { recursive: true });
        await fs.writeFile(path.join(bunCwdDir, relativeBunScript), "// readable notify script\n", "utf8");

        await runGeneratedNotifyHandler({
          trackerDir: path.join(tmp, "tracker-bun-run-cwd-relative-script"),
          notify: [fakeRuntimePath, "run", "--cwd", bunCwdDir, `./${relativeBunScript}`, "turn-ended"],
        });
        assert.match(
          await waitForFile(markerPath, { timeoutMs: 5000 }),
          new RegExp(`^run\\|--cwd\\|${bunCwdDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\|\\./${relativeBunScript}\\|turn-ended`),
        );
        await fs.rm(markerPath, { force: true });

        await runGeneratedNotifyHandler({
          trackerDir: path.join(tmp, "tracker-bun-run-inline-cwd-relative-script"),
          notify: [fakeRuntimePath, "run", `--cwd=${bunCwdDir}`, `./${relativeBunScript}`, "turn-ended"],
        });
        assert.match(
          await waitForFile(markerPath, { timeoutMs: 5000 }),
          new RegExp(`^run\\|--cwd=${bunCwdDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\|\\./${relativeBunScript}\\|turn-ended`),
        );
        await fs.rm(markerPath, { force: true });

        const processCwdOnlyScriptName = `process-cwd-only-bun-notify-${path.basename(tmp)}.js`;
        const processCwdOnlyScript = path.join(process.cwd(), processCwdOnlyScriptName);
        await fs.writeFile(processCwdOnlyScript, "// not under bun --cwd\n", "utf8");
        try {
          await runGeneratedNotifyHandler({
            trackerDir: path.join(tmp, "tracker-bun-run-cwd-rejects-process-cwd-script"),
            notify: [fakeRuntimePath, "run", "--cwd", bunCwdDir, `./${processCwdOnlyScriptName}`, "turn-ended"],
          });
          assert.equal(await waitForFile(markerPath, { timeoutMs: 500 }), null);

          await runGeneratedNotifyHandler({
            trackerDir: path.join(tmp, "tracker-bun-run-inline-cwd-rejects-process-cwd-script"),
            notify: [fakeRuntimePath, "run", `--cwd=${bunCwdDir}`, `./${processCwdOnlyScriptName}`, "turn-ended"],
          });
          assert.equal(await waitForFile(markerPath, { timeoutMs: 500 }), null);
        } finally {
          await fs.rm(processCwdOnlyScript, { force: true });
        }
      }

      if (runtimeName === "deno") {
        await runGeneratedNotifyHandler({
          trackerDir: path.join(tmp, "tracker-deno-run-lock-explicit-script"),
          notify: [fakeRuntimePath, "run", "--lock", lockFilePath, explicitScriptPath, "turn-ended"],
        });
        assert.equal(
          await waitForFile(markerPath, { timeoutMs: 5000 }),
          `run|--lock|${lockFilePath}|${explicitScriptPath}|turn-ended`,
        );
        await fs.rm(markerPath, { force: true });
      }

      await runGeneratedNotifyHandler({
        trackerDir: path.join(tmp, `tracker-env-${runtimeName}-run-explicit-script`),
        notify: ["/usr/bin/env", fakeRuntimePath, "run", explicitScriptPath, "turn-ended"],
      });
      assert.match(
        await waitForFile(markerPath, { timeoutMs: 5000 }),
        new RegExp(`^run\\|${explicitScriptPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\|turn-ended`),
      );
      await fs.rm(markerPath, { force: true });

      await runGeneratedNotifyHandler({
        trackerDir: path.join(tmp, `tracker-${runtimeName}-payload-token`),
        notify: [fakeRuntimePath, "turn-ended"],
      });
      assert.equal(await waitForFile(markerPath, { timeoutMs: 500 }), null);

      await runGeneratedNotifyHandler({
        trackerDir: path.join(tmp, `tracker-env-${runtimeName}-payload-token`),
        notify: ["/usr/bin/env", fakeRuntimePath, "turn-ended"],
      });
      assert.equal(await waitForFile(markerPath, { timeoutMs: 500 }), null);

      await runGeneratedNotifyHandler({
        trackerDir: path.join(tmp, `tracker-${runtimeName}-run-payload-token`),
        notify: [fakeRuntimePath, "run", "turn-ended"],
      });
      assert.equal(await waitForFile(markerPath, { timeoutMs: 500 }), null);

      const valueOptionPayloadNotify =
        runtimeName === "bun"
          ? [fakeRuntimePath, "run", "--cwd", tmp, "turn-ended"]
          : [fakeRuntimePath, "run", "--preload", explicitScriptPath, "turn-ended"];
      await runGeneratedNotifyHandler({
        trackerDir: path.join(tmp, `tracker-${runtimeName}-run-value-option-payload-token`),
        notify: valueOptionPayloadNotify,
      });
      assert.equal(await waitForFile(markerPath, { timeoutMs: 500 }), null);

      if (runtimeName === "deno") {
        await runGeneratedNotifyHandler({
          trackerDir: path.join(tmp, "tracker-deno-run-lock-payload-token"),
          notify: [fakeRuntimePath, "run", "--lock", lockFilePath, "turn-ended"],
        });
        assert.equal(await waitForFile(markerPath, { timeoutMs: 500 }), null);
      }

      await runGeneratedNotifyHandler({
        trackerDir: path.join(tmp, `tracker-env-${runtimeName}-run-payload-token`),
        notify: ["/usr/bin/env", fakeRuntimePath, "run", "turn-ended"],
      });
      assert.equal(await waitForFile(markerPath, { timeoutMs: 500 }), null);
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("notify handler preserves legitimate repeated payload args when chaining", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-notify-chain-"));
  try {
    const markerPath = path.join(tmp, "repeat-marker");
    const shimPath = path.join(tmp, "repeat-notify.js");
    await fs.writeFile(
      shimPath,
      `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, process.argv.slice(2).join('|'));\n`,
      "utf8",
    );

    await runGeneratedNotifyHandler({
      trackerDir: path.join(tmp, "tracker-repeat"),
      notify: [process.execPath, shimPath, "turn-ended"],
      args: ["--source=codex", "--include", "a", "--include", "b"],
    });

    const marker = await waitForFile(markerPath, { timeoutMs: 5000 });
    assert.equal(marker, "turn-ended|--include|a|--include|b");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("serve-time Codex notify repair installs TokenTracker and preserves Sky original", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-notify-repair-"));
  const prevCodexHome = process.env.CODEX_HOME;
  try {
    process.env.CODEX_HOME = path.join(tmp, ".codex");
    const trackerDir = path.join(tmp, ".tokentracker", "tracker");
    const binDir = path.join(tmp, ".tokentracker", "bin");
    await fs.mkdir(process.env.CODEX_HOME, { recursive: true });

    const skyNotify = [
      path.join(tmp, "SkyComputerUseClient.app", "Contents", "MacOS", "SkyComputerUseClient"),
      "turn-ended",
    ];
    await fs.writeFile(
      path.join(process.env.CODEX_HOME, "config.toml"),
      `notify = ${JSON.stringify(skyNotify)}\n`,
      "utf8",
    );

    const result = await repairCodexNotifyIntegration({
      home: tmp,
      trackerDir,
      binDir,
      safeMode: true,
    });

    assert.equal(result.changed, true);
    await fs.stat(path.join(binDir, "notify.cjs"));
    const config = await fs.readFile(path.join(process.env.CODEX_HOME, "config.toml"), "utf8");
    assert.match(config, /notify\.cjs/);
    const original = JSON.parse(
      await fs.readFile(path.join(trackerDir, "codex_notify_original.json"), "utf8"),
    );
    assert.deepEqual(original.notify, skyNotify);
  } finally {
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("serve-time runtime repair restores hooks for installed local providers", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-runtime-repair-"));
  const savedEnv = {
    CODEX_HOME: process.env.CODEX_HOME,
    GEMINI_HOME: process.env.GEMINI_HOME,
    OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR,
    CODEBUDDY_HOME: process.env.CODEBUDDY_HOME,
    WORKBUDDY_HOME: process.env.WORKBUDDY_HOME,
  };
  try {
    process.env.CODEX_HOME = path.join(tmp, ".codex");
    process.env.GEMINI_HOME = path.join(tmp, ".gemini");
    process.env.OPENCODE_CONFIG_DIR = path.join(tmp, ".config", "opencode");
    process.env.CODEBUDDY_HOME = path.join(tmp, ".codebuddy");
    process.env.WORKBUDDY_HOME = path.join(tmp, ".workbuddy");
    const trackerDir = path.join(tmp, ".tokentracker", "tracker");
    const binDir = path.join(tmp, ".tokentracker", "bin");
    await Promise.all([
      fs.mkdir(path.join(tmp, ".claude"), { recursive: true }),
      fs.mkdir(process.env.GEMINI_HOME, { recursive: true }),
      fs.mkdir(process.env.OPENCODE_CONFIG_DIR, { recursive: true }),
      fs.mkdir(process.env.CODEBUDDY_HOME, { recursive: true }),
      fs.mkdir(process.env.WORKBUDDY_HOME, { recursive: true }),
    ]);
    await fs.writeFile(
      path.join(tmp, ".claude", "settings.json"),
      JSON.stringify({ permissions: { allow: ["Read"] } }),
      "utf8",
    );

    const result = await repairRuntimeIntegrations({ home: tmp, trackerDir, binDir });

    assert.deepEqual(result.warnings, []);
    assert.equal(result.integrations.claude.changed, true);
    assert.equal(result.integrations.gemini.changed, true);
    assert.equal(result.integrations.opencode.changed, true);
    assert.equal(result.integrations.codebuddy.changed, true);
    assert.equal(result.integrations.workbuddy.changed, true);
    const notifyPath = path.join(binDir, "notify.cjs");
    await fs.stat(notifyPath);

    const claudeSettings = JSON.parse(
      await fs.readFile(path.join(tmp, ".claude", "settings.json"), "utf8"),
    );
    assert.deepEqual(claudeSettings.permissions, { allow: ["Read"] });
    assert.equal(
      flattenHookEntries(claudeSettings.hooks.SessionEnd).some(
        (hook) => hook.command === buildClaudeHookCommand(notifyPath),
      ),
      true,
    );
    assert.equal(
      flattenHookEntries(claudeSettings.hooks.Stop).some(
        (hook) => hook.command === buildClaudeHookCommand(notifyPath),
      ),
      true,
    );

    const geminiSettings = JSON.parse(
      await fs.readFile(path.join(process.env.GEMINI_HOME, "settings.json"), "utf8"),
    );
    assert.equal(geminiSettings.tools.enableHooks, true);
    assert.equal(
      flattenHookEntries(geminiSettings.hooks.SessionEnd).some(
        (hook) => hook.command === buildGeminiHookCommand(notifyPath),
      ),
      true,
    );
    assert.equal(
      await fs.readFile(
        path.join(process.env.OPENCODE_CONFIG_DIR, "plugin", DEFAULT_PLUGIN_NAME),
        "utf8",
      ),
      buildOpencodePlugin({ notifyPath }),
    );
  } finally {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("serve-time Codex notify repair leaves Sky wrapping TokenTracker unchanged", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-notify-repair-"));
  const prevCodexHome = process.env.CODEX_HOME;
  try {
    process.env.CODEX_HOME = path.join(tmp, ".codex");
    const trackerDir = path.join(tmp, ".tokentracker", "tracker");
    const binDir = path.join(tmp, ".tokentracker", "bin");
    const notifyPath = path.join(binDir, "notify.cjs");
    await fs.mkdir(process.env.CODEX_HOME, { recursive: true });

    const tokenTrackerNotify = ["/usr/bin/env", "node", notifyPath];
    const skyNotify = [
      path.join(tmp, "SkyComputerUseClient.app", "Contents", "MacOS", "SkyComputerUseClient"),
      "turn-ended",
      "--previous-notify",
      JSON.stringify(tokenTrackerNotify),
    ];
    const codexConfigPath = path.join(process.env.CODEX_HOME, "config.toml");
    await fs.writeFile(codexConfigPath, `notify = ${JSON.stringify(skyNotify)}\n`, "utf8");

    const result = await repairCodexNotifyIntegration({
      home: tmp,
      trackerDir,
      binDir,
      safeMode: true,
    });

    assert.equal(result.changed, false);
    assert.equal(result.skippedReason, "already-wrapped");
    assert.deepEqual(await fs.readFile(codexConfigPath, "utf8"), `notify = ${JSON.stringify(skyNotify)}\n`);
    await assert.rejects(
      fs.stat(path.join(trackerDir, "codex_notify_original.json")),
      /ENOENT/,
    );
  } finally {
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("serve-time Codex notify repair refreshes stale backup when active notify is Sky", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-notify-repair-"));
  const prevCodexHome = process.env.CODEX_HOME;
  try {
    process.env.CODEX_HOME = path.join(tmp, ".codex");
    const trackerDir = path.join(tmp, ".tokentracker", "tracker");
    const binDir = path.join(tmp, ".tokentracker", "bin");
    await fs.mkdir(process.env.CODEX_HOME, { recursive: true });
    await fs.mkdir(trackerDir, { recursive: true });

    const staleNotify = ["old-notify", "arg"];
    await fs.writeFile(
      path.join(trackerDir, "codex_notify_original.json"),
      JSON.stringify({ notify: staleNotify, capturedAt: "2026-01-01T00:00:00.000Z" }) + "\n",
      "utf8",
    );
    const skyNotify = [
      path.join(tmp, "SkyComputerUseClient.app", "Contents", "MacOS", "SkyComputerUseClient"),
      "turn-ended",
    ];
    await fs.writeFile(
      path.join(process.env.CODEX_HOME, "config.toml"),
      `notify = ${JSON.stringify(skyNotify)}\n`,
      "utf8",
    );

    const result = await repairCodexNotifyIntegration({
      home: tmp,
      trackerDir,
      binDir,
      safeMode: true,
    });

    assert.equal(result.changed, true);
    const original = JSON.parse(
      await fs.readFile(path.join(trackerDir, "codex_notify_original.json"), "utf8"),
    );
    assert.deepEqual(original.notify, skyNotify);
  } finally {
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("serve-time Codex notify repair clears stale backup when active notify is absent", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-notify-repair-"));
  let restoreHome = () => {};
  const prevCodexHome = process.env.CODEX_HOME;
  const prevWrite = process.stdout.write;
  try {
    restoreHome = withHome(tmp);
    process.env.CODEX_HOME = path.join(tmp, ".codex");
    const trackerDir = path.join(tmp, ".tokentracker", "tracker");
    const binDir = path.join(tmp, ".tokentracker", "bin");
    await fs.mkdir(process.env.CODEX_HOME, { recursive: true });
    await fs.mkdir(trackerDir, { recursive: true });

    const staleNotify = ["old-notify", "arg"];
    const notifyOriginalPath = path.join(trackerDir, "codex_notify_original.json");
    await fs.writeFile(
      notifyOriginalPath,
      JSON.stringify({ notify: staleNotify, capturedAt: "2026-01-01T00:00:00.000Z" }) + "\n",
      "utf8",
    );
    const codexConfigPath = path.join(process.env.CODEX_HOME, "config.toml");
    await fs.writeFile(codexConfigPath, "model = \"gpt-5\"\n", "utf8");

    const result = await repairCodexNotifyIntegration({
      home: tmp,
      trackerDir,
      binDir,
      safeMode: true,
    });

    assert.equal(result.changed, true);
    const original = JSON.parse(await fs.readFile(notifyOriginalPath, "utf8"));
    assert.equal(original.notify, null);

    process.stdout.write = () => true;
    await cmdUninstall([]);
    const restored = await fs.readFile(codexConfigPath, "utf8");
    assert.match(restored, /model = "gpt-5"/);
    assert.doesNotMatch(restored, /^notify\s*=/m);
    assert.doesNotMatch(restored, /old-notify/);
  } finally {
    process.stdout.write = prevWrite;
    restoreHome();
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("serve-time Codex notify repair skips unknown third-party notify", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-notify-repair-"));
  const prevCodexHome = process.env.CODEX_HOME;
  try {
    process.env.CODEX_HOME = path.join(tmp, ".codex");
    const trackerDir = path.join(tmp, ".tokentracker", "tracker");
    const binDir = path.join(tmp, ".tokentracker", "bin");
    await fs.mkdir(process.env.CODEX_HOME, { recursive: true });
    await fs.writeFile(
      path.join(process.env.CODEX_HOME, "config.toml"),
      'notify = ["third-party-notify", "arg"]\n',
      "utf8",
    );

    const result = await repairCodexNotifyIntegration({
      home: tmp,
      trackerDir,
      binDir,
      safeMode: true,
    });

    assert.equal(result.changed, false);
    assert.equal(result.skippedReason, "external-notify");
    const config = await fs.readFile(path.join(process.env.CODEX_HOME, "config.toml"), "utf8");
    assert.match(config, /third-party-notify/);
    assert.doesNotMatch(config, /notify\.cjs/);
  } finally {
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("serve-time Codex notify repair skips unknown notify.cjs command", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-notify-repair-"));
  const prevCodexHome = process.env.CODEX_HOME;
  try {
    process.env.CODEX_HOME = path.join(tmp, ".codex");
    const trackerDir = path.join(tmp, ".tokentracker", "tracker");
    const binDir = path.join(tmp, ".tokentracker", "bin");
    await fs.mkdir(process.env.CODEX_HOME, { recursive: true });
    const externalNotify = ["/usr/bin/env", "node", path.join(tmp, "custom", "notify.cjs")];
    await fs.writeFile(
      path.join(process.env.CODEX_HOME, "config.toml"),
      `notify = ${JSON.stringify(externalNotify)}\n`,
      "utf8",
    );

    const result = await repairCodexNotifyIntegration({
      home: tmp,
      trackerDir,
      binDir,
      safeMode: true,
    });

    assert.equal(result.changed, false);
    assert.equal(result.skippedReason, "external-notify");
    const config = await fs.readFile(path.join(process.env.CODEX_HOME, "config.toml"), "utf8");
    assert.match(config, /custom/);
    assert.doesNotMatch(config, /\.tokentracker/);
    await assert.rejects(
      fs.stat(path.join(trackerDir, "codex_notify_original.json")),
      /ENOENT/,
    );
  } finally {
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("notify handler still chains normal original notify commands", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-notify-chain-"));
  try {
    const markerPath = path.join(tmp, "safe-marker");
    const shimPath = path.join(tmp, "safe-notify.js");
    await fs.writeFile(
      shimPath,
      `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, process.argv.slice(2).join('|'));\n`,
      "utf8",
    );

    await runGeneratedNotifyHandler({
      trackerDir: path.join(tmp, "tracker-safe"),
      notify: [process.execPath, shimPath],
    });

    const marker = await waitForFile(markerPath, { timeoutMs: 5000 });
    assert.ok(marker, "expected chained notify marker to be written");
    assert.ok(marker.includes("turn-ended"), "expected payload args to be forwarded");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("notify handler chains the independent Acode original notify", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-acode-notify-chain-"));
  try {
    const markerPath = path.join(tmp, "acode-marker");
    const shimPath = path.join(tmp, "acode-notify.js");
    await fs.writeFile(
      shimPath,
      `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, process.argv.slice(2).join('|'));\n`,
      "utf8",
    );

    await runGeneratedNotifyHandler({
      trackerDir: path.join(tmp, "tracker-acode"),
      notify: [process.execPath, shimPath],
      args: ["--source=acode", "turn-ended"],
      originalSource: "acode",
    });

    const marker = await waitForFile(markerPath, { timeoutMs: 5000 });
    assert.ok(marker, "expected Acode chained notify marker to be written");
    assert.ok(marker.includes("turn-ended"));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("init preserves existing config fields and custom URLs", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-init-config-"));
  let restoreHome = () => {};
  const prevCodexHome = process.env.CODEX_HOME;
  const prevToken = process.env.TOKENTRACKER_DEVICE_TOKEN;
  const prevOpencodeConfigDir = process.env.OPENCODE_CONFIG_DIR;
  const prevWrite = process.stdout.write;

  try {
    restoreHome = withHome(tmp);
    process.env.CODEX_HOME = path.join(tmp, ".codex");
    delete process.env.TOKENTRACKER_DEVICE_TOKEN;
    process.env.OPENCODE_CONFIG_DIR = path.join(tmp, ".config", "opencode");

    const trackerDir = path.join(tmp, ".tokentracker", "tracker");
    await fs.mkdir(trackerDir, { recursive: true });
    await fs.writeFile(
      path.join(trackerDir, "config.json"),
      JSON.stringify(
        {
          installedAt: "2026-04-01T00:00:00.000Z",
          baseUrl: "https://self-hosted.example",
          dashboardUrl: "https://dashboard.example",
          deviceToken: "device-token",
          deviceId: "device-id",
          customFlag: true,
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    process.stdout.write = () => true;
    await cmdInit(["--yes", "--no-auth", "--no-open"]);

    const config = JSON.parse(await fs.readFile(path.join(trackerDir, "config.json"), "utf8"));
    assert.equal(config.installedAt, "2026-04-01T00:00:00.000Z");
    assert.equal(config.baseUrl, "https://self-hosted.example");
    assert.equal(config.dashboardUrl, "https://dashboard.example");
    assert.equal(config.deviceToken, "device-token");
    assert.equal(config.deviceId, "device-id");
    assert.equal(config.customFlag, true);
  } finally {
    process.stdout.write = prevWrite;
    restoreHome();
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    if (prevToken === undefined) delete process.env.TOKENTRACKER_DEVICE_TOKEN;
    else process.env.TOKENTRACKER_DEVICE_TOKEN = prevToken;
    if (prevOpencodeConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = prevOpencodeConfigDir;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("init then uninstall restores original Codex notify (when pre-existing notify exists)", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-init-uninstall-"));
  let restoreHome = () => {};
  const prevCodexHome = process.env.CODEX_HOME;
  const prevToken = process.env.TOKENTRACKER_DEVICE_TOKEN;
  const prevOpencodeConfigDir = process.env.OPENCODE_CONFIG_DIR;
  const prevWrite = process.stdout.write;

  try {
    restoreHome = withHome(tmp);
    // This case is the one that verifies init actually runs the first sync (it
    // asserts cursors.json is written), so opt back into the real runtime copy +
    // first sync that the file-level skips otherwise disable.
    delete process.env.TOKENTRACKER_SKIP_LOCAL_RUNTIME_COPY;
    delete process.env.TOKENTRACKER_SKIP_FIRST_SYNC;
    process.env.CODEX_HOME = path.join(tmp, ".codex-alt");
    delete process.env.TOKENTRACKER_DEVICE_TOKEN;
    process.env.OPENCODE_CONFIG_DIR = path.join(tmp, ".config", "opencode");
    await fs.mkdir(process.env.CODEX_HOME, { recursive: true });

    const codexConfigPath = path.join(process.env.CODEX_HOME, "config.toml");
    const originalNotify = 'notify = ["echo", "hello"]\n';
    await fs.writeFile(codexConfigPath, originalNotify, "utf8");

    process.stdout.write = () => true;
    await cmdInit(["--yes", "--no-auth", "--no-open", "--base-url", "https://example.invalid"]);

    const installed = await fs.readFile(codexConfigPath, "utf8");
    assert.match(installed, /^notify\s*=\s*\[.+\]\s*$/m);
    assert.ok(!installed.includes('["echo", "hello"]'), "expected init to override notify");

    const cursorsPath = path.join(tmp, ".tokentracker", "tracker", "cursors.json");
    const cursorsRaw = await waitForFile(cursorsPath);
    assert.ok(cursorsRaw, "expected init to trigger sync and write cursors");
    const cursors = JSON.parse(cursorsRaw);
    assert.ok(typeof cursors.updatedAt === "string" && cursors.updatedAt.length > 0);

    await cmdUninstall([]);

    const restored = await fs.readFile(codexConfigPath, "utf8");
    assert.ok(
      restored.includes('notify = ["echo", "hello"]'),
      "expected uninstall to restore original notify",
    );

    const notifyHandlerPath = path.join(tmp, ".tokentracker", "bin", "notify.cjs");
    await assert.rejects(fs.stat(notifyHandlerPath), /ENOENT/);
  } finally {
    process.stdout.write = prevWrite;
    restoreHome();
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    if (prevToken === undefined) delete process.env.TOKENTRACKER_DEVICE_TOKEN;
    else process.env.TOKENTRACKER_DEVICE_TOKEN = prevToken;
    if (prevOpencodeConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = prevOpencodeConfigDir;
    process.env.TOKENTRACKER_SKIP_LOCAL_RUNTIME_COPY = "1";
    process.env.TOKENTRACKER_SKIP_FIRST_SYNC = "1";
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("init refreshes stale Codex backup when current notify is external", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-init-refresh-backup-"));
  let restoreHome = () => {};
  const prevCodexHome = process.env.CODEX_HOME;
  const prevToken = process.env.TOKENTRACKER_DEVICE_TOKEN;
  const prevOpencodeConfigDir = process.env.OPENCODE_CONFIG_DIR;
  const prevWrite = process.stdout.write;

  try {
    restoreHome = withHome(tmp);
    process.env.CODEX_HOME = path.join(tmp, ".codex");
    delete process.env.TOKENTRACKER_DEVICE_TOKEN;
    process.env.OPENCODE_CONFIG_DIR = path.join(tmp, ".config", "opencode");
    await fs.mkdir(process.env.CODEX_HOME, { recursive: true });

    const trackerDir = path.join(tmp, ".tokentracker", "tracker");
    await fs.mkdir(trackerDir, { recursive: true });
    const staleNotify = ["old-notify", "arg"];
    await fs.writeFile(
      path.join(trackerDir, "codex_notify_original.json"),
      JSON.stringify({ notify: staleNotify, capturedAt: "2026-01-01T00:00:00.000Z" }) + "\n",
      "utf8",
    );
    const externalNotify = ["third-party-notify", "new"];
    const codexConfigPath = path.join(process.env.CODEX_HOME, "config.toml");
    await fs.writeFile(codexConfigPath, `notify = ${JSON.stringify(externalNotify)}\n`, "utf8");

    process.stdout.write = () => true;
    await cmdInit(["--yes", "--no-auth", "--no-open", "--base-url", "https://example.invalid"]);

    const original = JSON.parse(
      await fs.readFile(path.join(trackerDir, "codex_notify_original.json"), "utf8"),
    );
    assert.deepEqual(original.notify, externalNotify);

    await cmdUninstall([]);
    const restored = await fs.readFile(codexConfigPath, "utf8");
    assert.match(restored, /third-party-notify/);
    assert.doesNotMatch(restored, /old-notify/);
  } finally {
    process.stdout.write = prevWrite;
    restoreHome();
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    if (prevToken === undefined) delete process.env.TOKENTRACKER_DEVICE_TOKEN;
    else process.env.TOKENTRACKER_DEVICE_TOKEN = prevToken;
    if (prevOpencodeConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = prevOpencodeConfigDir;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("init clears stale Codex backup when current notify is absent", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-init-clear-backup-"));
  let restoreHome = () => {};
  const prevCodexHome = process.env.CODEX_HOME;
  const prevToken = process.env.TOKENTRACKER_DEVICE_TOKEN;
  const prevOpencodeConfigDir = process.env.OPENCODE_CONFIG_DIR;
  const prevWrite = process.stdout.write;

  try {
    restoreHome = withHome(tmp);
    process.env.CODEX_HOME = path.join(tmp, ".codex");
    delete process.env.TOKENTRACKER_DEVICE_TOKEN;
    process.env.OPENCODE_CONFIG_DIR = path.join(tmp, ".config", "opencode");
    await fs.mkdir(process.env.CODEX_HOME, { recursive: true });

    const trackerDir = path.join(tmp, ".tokentracker", "tracker");
    await fs.mkdir(trackerDir, { recursive: true });
    const staleNotify = ["old-notify", "arg"];
    const notifyOriginalPath = path.join(trackerDir, "codex_notify_original.json");
    await fs.writeFile(
      notifyOriginalPath,
      JSON.stringify({ notify: staleNotify, capturedAt: "2026-01-01T00:00:00.000Z" }) + "\n",
      "utf8",
    );
    const codexConfigPath = path.join(process.env.CODEX_HOME, "config.toml");
    await fs.writeFile(codexConfigPath, "model = \"gpt-5\"\n", "utf8");

    process.stdout.write = () => true;
    await cmdInit(["--yes", "--no-auth", "--no-open", "--base-url", "https://example.invalid"]);

    const original = JSON.parse(await fs.readFile(notifyOriginalPath, "utf8"));
    assert.equal(original.notify, null);

    await cmdUninstall([]);
    const restored = await fs.readFile(codexConfigPath, "utf8");
    assert.match(restored, /model = "gpt-5"/);
    assert.doesNotMatch(restored, /^notify\s*=/m);
    assert.doesNotMatch(restored, /old-notify/);
  } finally {
    process.stdout.write = prevWrite;
    restoreHome();
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    if (prevToken === undefined) delete process.env.TOKENTRACKER_DEVICE_TOKEN;
    else process.env.TOKENTRACKER_DEVICE_TOKEN = prevToken;
    if (prevOpencodeConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = prevOpencodeConfigDir;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("opencode plugin uses session.updated event", () => {
  const plugin = buildOpencodePlugin({ notifyPath: "/tmp/notify.cjs" });
  assert.match(plugin, /session\.updated/);
});

test("opencode config exports plugin constants", () => {
  assert.equal(typeof PLUGIN_MARKER, "string");
  assert.ok(PLUGIN_MARKER.length > 0);
  assert.equal(DEFAULT_EVENT, "session.updated");
  assert.equal(DEFAULT_PLUGIN_NAME, "tokentracker.js");
});

test("init then uninstall removes notify when none existed", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-init-uninstall-"));
  let restoreHome = () => {};
  const prevCodexHome = process.env.CODEX_HOME;
  const prevToken = process.env.TOKENTRACKER_DEVICE_TOKEN;
  const prevOpencodeConfigDir = process.env.OPENCODE_CONFIG_DIR;
  const prevWrite = process.stdout.write;

  try {
    restoreHome = withHome(tmp);
    process.env.CODEX_HOME = path.join(tmp, ".codex");
    delete process.env.TOKENTRACKER_DEVICE_TOKEN;
    process.env.OPENCODE_CONFIG_DIR = path.join(tmp, ".config", "opencode");
    await fs.mkdir(process.env.CODEX_HOME, { recursive: true });

    const codexConfigPath = path.join(process.env.CODEX_HOME, "config.toml");
    await fs.writeFile(codexConfigPath, "# empty\n", "utf8");

    process.stdout.write = () => true;
    await cmdInit(["--yes", "--no-auth", "--no-open", "--base-url", "https://example.invalid"]);

    const installed = await fs.readFile(codexConfigPath, "utf8");
    assert.match(installed, /^notify\s*=\s*\[.+\]\s*$/m);

    await cmdUninstall([]);

    const restored = await fs.readFile(codexConfigPath, "utf8");
    assert.ok(
      !/^notify\s*=.*$/m.test(restored),
      "expected uninstall to remove notify when none existed",
    );
  } finally {
    process.stdout.write = prevWrite;
    restoreHome();
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    if (prevToken === undefined) delete process.env.TOKENTRACKER_DEVICE_TOKEN;
    else process.env.TOKENTRACKER_DEVICE_TOKEN = prevToken;
    if (prevOpencodeConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = prevOpencodeConfigDir;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("uninstall does not restore stale backup over active third-party Codex notify", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-init-uninstall-"));
  let restoreHome = () => {};
  const prevCodexHome = process.env.CODEX_HOME;
  const prevToken = process.env.TOKENTRACKER_DEVICE_TOKEN;
  const prevOpencodeConfigDir = process.env.OPENCODE_CONFIG_DIR;
  const prevWrite = process.stdout.write;

  try {
    restoreHome = withHome(tmp);
    process.env.CODEX_HOME = path.join(tmp, ".codex");
    delete process.env.TOKENTRACKER_DEVICE_TOKEN;
    process.env.OPENCODE_CONFIG_DIR = path.join(tmp, ".config", "opencode");
    await fs.mkdir(process.env.CODEX_HOME, { recursive: true });

    const trackerDir = path.join(tmp, ".tokentracker", "tracker");
    await fs.mkdir(trackerDir, { recursive: true });
    const codexConfigPath = path.join(process.env.CODEX_HOME, "config.toml");
    await fs.writeFile(codexConfigPath, 'notify = ["third-party-notify", "new"]\n', "utf8");
    await fs.writeFile(
      path.join(trackerDir, "codex_notify_original.json"),
      JSON.stringify({ notify: ["old-notify"], capturedAt: "2026-01-01T00:00:00.000Z" }) + "\n",
      "utf8",
    );

    process.stdout.write = () => true;
    await cmdUninstall([]);

    const restored = await fs.readFile(codexConfigPath, "utf8");
    assert.equal(restored, 'notify = ["third-party-notify", "new"]\n');
  } finally {
    process.stdout.write = prevWrite;
    restoreHome();
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    if (prevToken === undefined) delete process.env.TOKENTRACKER_DEVICE_TOKEN;
    else process.env.TOKENTRACKER_DEVICE_TOKEN = prevToken;
    if (prevOpencodeConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = prevOpencodeConfigDir;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("init skips Codex notify when config is missing", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-init-uninstall-"));
  let restoreHome = () => {};
  const prevCodexHome = process.env.CODEX_HOME;
  const prevToken = process.env.TOKENTRACKER_DEVICE_TOKEN;
  const prevOpencodeConfigDir = process.env.OPENCODE_CONFIG_DIR;
  const prevGeminiHome = process.env.GEMINI_HOME;
  const prevWrite = process.stdout.write;

  try {
    restoreHome = withHome(tmp);
    process.env.CODEX_HOME = path.join(tmp, ".codex");
    process.env.GEMINI_HOME = path.join(tmp, ".gemini");
    delete process.env.TOKENTRACKER_DEVICE_TOKEN;
    process.env.OPENCODE_CONFIG_DIR = path.join(tmp, ".config", "opencode");

    process.stdout.write = () => true;
    await cmdInit(["--yes", "--no-auth", "--no-open", "--base-url", "https://example.invalid"]);

    const codexConfigPath = path.join(process.env.CODEX_HOME, "config.toml");
    await assert.rejects(fs.stat(codexConfigPath), /ENOENT/);
  } finally {
    process.stdout.write = prevWrite;
    restoreHome();
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    if (prevToken === undefined) delete process.env.TOKENTRACKER_DEVICE_TOKEN;
    else process.env.TOKENTRACKER_DEVICE_TOKEN = prevToken;
    if (prevOpencodeConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = prevOpencodeConfigDir;
    if (prevGeminiHome === undefined) delete process.env.GEMINI_HOME;
    else process.env.GEMINI_HOME = prevGeminiHome;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("init then uninstall restores original Every Code notify (when config exists)", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-init-uninstall-"));
  let restoreHome = () => {};
  const prevCodexHome = process.env.CODEX_HOME;
  const prevCodeHome = process.env.CODE_HOME;
  const prevToken = process.env.TOKENTRACKER_DEVICE_TOKEN;
  const prevOpencodeConfigDir = process.env.OPENCODE_CONFIG_DIR;
  const prevWrite = process.stdout.write;

  try {
    restoreHome = withHome(tmp);
    process.env.CODEX_HOME = path.join(tmp, ".codex");
    process.env.CODE_HOME = path.join(tmp, ".code");
    delete process.env.TOKENTRACKER_DEVICE_TOKEN;
    process.env.OPENCODE_CONFIG_DIR = path.join(tmp, ".config", "opencode");
    await fs.mkdir(process.env.CODEX_HOME, { recursive: true });
    await fs.mkdir(process.env.CODE_HOME, { recursive: true });

    const codexConfigPath = path.join(process.env.CODEX_HOME, "config.toml");
    await fs.writeFile(codexConfigPath, "# empty\n", "utf8");

    const codeConfigPath = path.join(process.env.CODE_HOME, "config.toml");
    const originalNotify = 'notify = ["echo", "hello-code"]\n';
    await fs.writeFile(codeConfigPath, originalNotify, "utf8");

    process.stdout.write = () => true;
    await cmdInit(["--yes", "--no-auth", "--no-open", "--base-url", "https://example.invalid"]);

    const installed = await fs.readFile(codeConfigPath, "utf8");
    assert.match(installed, /notify\s*=\s*\[[^\n]*notify\.cjs[^\n]*--source=every-code[^\n]*\]/);
    assert.ok(
      !installed.includes('["echo", "hello-code"]'),
      "expected init to override Every Code notify",
    );

    await cmdUninstall([]);

    const restored = await fs.readFile(codeConfigPath, "utf8");
    assert.ok(
      restored.includes('notify = ["echo", "hello-code"]'),
      "expected uninstall to restore Every Code notify",
    );
  } finally {
    process.stdout.write = prevWrite;
    restoreHome();
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    if (prevCodeHome === undefined) delete process.env.CODE_HOME;
    else process.env.CODE_HOME = prevCodeHome;
    if (prevToken === undefined) delete process.env.TOKENTRACKER_DEVICE_TOKEN;
    else process.env.TOKENTRACKER_DEVICE_TOKEN = prevToken;
    if (prevOpencodeConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = prevOpencodeConfigDir;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("init then uninstall restores original Acode notify", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-acode-init-uninstall-"));
  let restoreHome = () => {};
  const prevCodexHome = process.env.CODEX_HOME;
  const prevAcodeHome = process.env.TOKENTRACKER_ACODE_HOME;
  const prevToken = process.env.TOKENTRACKER_DEVICE_TOKEN;
  const prevOpencodeConfigDir = process.env.OPENCODE_CONFIG_DIR;
  const prevWrite = process.stdout.write;

  try {
    restoreHome = withHome(tmp);
    process.env.CODEX_HOME = path.join(tmp, ".codex");
    process.env.TOKENTRACKER_ACODE_HOME = path.join(tmp, ".acode");
    delete process.env.TOKENTRACKER_DEVICE_TOKEN;
    process.env.OPENCODE_CONFIG_DIR = path.join(tmp, ".config", "opencode");
    await fs.mkdir(process.env.CODEX_HOME, { recursive: true });
    await fs.mkdir(process.env.TOKENTRACKER_ACODE_HOME, { recursive: true });
    await fs.writeFile(path.join(process.env.CODEX_HOME, "config.toml"), "# empty\n", "utf8");
    const acodeConfigPath = path.join(process.env.TOKENTRACKER_ACODE_HOME, "config.toml");
    await fs.writeFile(acodeConfigPath, 'notify = ["echo", "hello-acode"]\n', "utf8");

    process.stdout.write = () => true;
    await cmdInit(["--yes", "--no-auth", "--no-open", "--base-url", "https://example.invalid"]);

    const installed = await fs.readFile(acodeConfigPath, "utf8");
    assert.match(installed, /notify\s*=\s*\[[^\n]*notify\.cjs[^\n]*--source=acode[^\n]*\]/);
    assert.doesNotMatch(installed, /hello-acode/);

    await cmdUninstall([]);

    const restored = await fs.readFile(acodeConfigPath, "utf8");
    assert.match(restored, /notify = \["echo", "hello-acode"\]/);
  } finally {
    process.stdout.write = prevWrite;
    restoreHome();
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    if (prevAcodeHome === undefined) delete process.env.TOKENTRACKER_ACODE_HOME;
    else process.env.TOKENTRACKER_ACODE_HOME = prevAcodeHome;
    if (prevToken === undefined) delete process.env.TOKENTRACKER_DEVICE_TOKEN;
    else process.env.TOKENTRACKER_DEVICE_TOKEN = prevToken;
    if (prevOpencodeConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = prevOpencodeConfigDir;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("init clears stale Every Code backup when current notify is absent", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-init-uninstall-"));
  let restoreHome = () => {};
  const prevCodexHome = process.env.CODEX_HOME;
  const prevCodeHome = process.env.CODE_HOME;
  const prevToken = process.env.TOKENTRACKER_DEVICE_TOKEN;
  const prevOpencodeConfigDir = process.env.OPENCODE_CONFIG_DIR;
  const prevWrite = process.stdout.write;

  try {
    restoreHome = withHome(tmp);
    process.env.CODEX_HOME = path.join(tmp, ".codex");
    process.env.CODE_HOME = path.join(tmp, ".code");
    delete process.env.TOKENTRACKER_DEVICE_TOKEN;
    process.env.OPENCODE_CONFIG_DIR = path.join(tmp, ".config", "opencode");
    await fs.mkdir(process.env.CODEX_HOME, { recursive: true });
    await fs.mkdir(process.env.CODE_HOME, { recursive: true });

    const codexConfigPath = path.join(process.env.CODEX_HOME, "config.toml");
    await fs.writeFile(codexConfigPath, "# empty\n", "utf8");

    const trackerDir = path.join(tmp, ".tokentracker", "tracker");
    await fs.mkdir(trackerDir, { recursive: true });
    const staleNotify = ["old-code-notify", "arg"];
    const notifyOriginalPath = path.join(trackerDir, "code_notify_original.json");
    await fs.writeFile(
      notifyOriginalPath,
      JSON.stringify({ notify: staleNotify, capturedAt: "2026-01-01T00:00:00.000Z" }) + "\n",
      "utf8",
    );
    const codeConfigPath = path.join(process.env.CODE_HOME, "config.toml");
    await fs.writeFile(codeConfigPath, "model = \"gpt-5\"\n", "utf8");

    process.stdout.write = () => true;
    await cmdInit(["--yes", "--no-auth", "--no-open", "--base-url", "https://example.invalid"]);

    const original = JSON.parse(await fs.readFile(notifyOriginalPath, "utf8"));
    assert.equal(original.notify, null);

    await cmdUninstall([]);
    const restored = await fs.readFile(codeConfigPath, "utf8");
    assert.match(restored, /model = "gpt-5"/);
    assert.doesNotMatch(restored, /^notify\s*=/m);
    assert.doesNotMatch(restored, /old-code-notify/);
  } finally {
    process.stdout.write = prevWrite;
    restoreHome();
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    if (prevCodeHome === undefined) delete process.env.CODE_HOME;
    else process.env.CODE_HOME = prevCodeHome;
    if (prevToken === undefined) delete process.env.TOKENTRACKER_DEVICE_TOKEN;
    else process.env.TOKENTRACKER_DEVICE_TOKEN = prevToken;
    if (prevOpencodeConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = prevOpencodeConfigDir;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("init refreshes stale Every Code backup when current notify is external", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-init-uninstall-"));
  let restoreHome = () => {};
  const prevCodexHome = process.env.CODEX_HOME;
  const prevCodeHome = process.env.CODE_HOME;
  const prevToken = process.env.TOKENTRACKER_DEVICE_TOKEN;
  const prevOpencodeConfigDir = process.env.OPENCODE_CONFIG_DIR;
  const prevWrite = process.stdout.write;

  try {
    restoreHome = withHome(tmp);
    process.env.CODEX_HOME = path.join(tmp, ".codex");
    process.env.CODE_HOME = path.join(tmp, ".code");
    delete process.env.TOKENTRACKER_DEVICE_TOKEN;
    process.env.OPENCODE_CONFIG_DIR = path.join(tmp, ".config", "opencode");
    await fs.mkdir(process.env.CODEX_HOME, { recursive: true });
    await fs.mkdir(process.env.CODE_HOME, { recursive: true });

    const codexConfigPath = path.join(process.env.CODEX_HOME, "config.toml");
    await fs.writeFile(codexConfigPath, "# empty\n", "utf8");

    const trackerDir = path.join(tmp, ".tokentracker", "tracker");
    await fs.mkdir(trackerDir, { recursive: true });
    const staleNotify = ["old-code-notify", "arg"];
    const notifyOriginalPath = path.join(trackerDir, "code_notify_original.json");
    await fs.writeFile(
      notifyOriginalPath,
      JSON.stringify({ notify: staleNotify, capturedAt: "2026-01-01T00:00:00.000Z" }) + "\n",
      "utf8",
    );
    const externalNotify = ["third-party-code-notify", "new"];
    const codeConfigPath = path.join(process.env.CODE_HOME, "config.toml");
    await fs.writeFile(codeConfigPath, `notify = ${JSON.stringify(externalNotify)}\n`, "utf8");

    process.stdout.write = () => true;
    await cmdInit(["--yes", "--no-auth", "--no-open", "--base-url", "https://example.invalid"]);

    const original = JSON.parse(await fs.readFile(notifyOriginalPath, "utf8"));
    assert.deepEqual(original.notify, externalNotify);

    await cmdUninstall([]);
    const restored = await fs.readFile(codeConfigPath, "utf8");
    assert.match(restored, /third-party-code-notify/);
    assert.doesNotMatch(restored, /old-code-notify/);
  } finally {
    process.stdout.write = prevWrite;
    restoreHome();
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    if (prevCodeHome === undefined) delete process.env.CODE_HOME;
    else process.env.CODE_HOME = prevCodeHome;
    if (prevToken === undefined) delete process.env.TOKENTRACKER_DEVICE_TOKEN;
    else process.env.TOKENTRACKER_DEVICE_TOKEN = prevToken;
    if (prevOpencodeConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = prevOpencodeConfigDir;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("init skips Every Code notify when config is missing", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-init-uninstall-"));
  let restoreHome = () => {};
  const prevCodexHome = process.env.CODEX_HOME;
  const prevCodeHome = process.env.CODE_HOME;
  const prevToken = process.env.TOKENTRACKER_DEVICE_TOKEN;
  const prevOpencodeConfigDir = process.env.OPENCODE_CONFIG_DIR;
  const prevWrite = process.stdout.write;

  try {
    restoreHome = withHome(tmp);
    process.env.CODEX_HOME = path.join(tmp, ".codex");
    process.env.CODE_HOME = path.join(tmp, ".code");
    delete process.env.TOKENTRACKER_DEVICE_TOKEN;
    process.env.OPENCODE_CONFIG_DIR = path.join(tmp, ".config", "opencode");
    await fs.mkdir(process.env.CODEX_HOME, { recursive: true });
    await fs.mkdir(process.env.CODE_HOME, { recursive: true });

    const codexConfigPath = path.join(process.env.CODEX_HOME, "config.toml");
    await fs.writeFile(codexConfigPath, "# empty\n", "utf8");

    process.stdout.write = () => true;
    await cmdInit(["--yes", "--no-auth", "--no-open", "--base-url", "https://example.invalid"]);

    const codeConfigPath = path.join(process.env.CODE_HOME, "config.toml");
    await assert.rejects(fs.stat(codeConfigPath), /ENOENT/);
  } finally {
    process.stdout.write = prevWrite;
    restoreHome();
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    if (prevCodeHome === undefined) delete process.env.CODE_HOME;
    else process.env.CODE_HOME = prevCodeHome;
    if (prevToken === undefined) delete process.env.TOKENTRACKER_DEVICE_TOKEN;
    else process.env.TOKENTRACKER_DEVICE_TOKEN = prevToken;
    if (prevOpencodeConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = prevOpencodeConfigDir;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("uninstall skips notify restore when no backup and notify not installed", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-init-uninstall-"));
  let restoreHome = () => {};
  const prevCodexHome = process.env.CODEX_HOME;
  const prevCodeHome = process.env.CODE_HOME;
  const prevOpencodeConfigDir = process.env.OPENCODE_CONFIG_DIR;
  const prevWrite = process.stdout.write;

  try {
    restoreHome = withHome(tmp);
    process.env.CODEX_HOME = path.join(tmp, ".codex");
    process.env.CODE_HOME = path.join(tmp, ".code");
    process.env.OPENCODE_CONFIG_DIR = path.join(tmp, ".config", "opencode");
    await fs.mkdir(process.env.CODEX_HOME, { recursive: true });
    await fs.mkdir(process.env.CODE_HOME, { recursive: true });

    const codexConfigPath = path.join(process.env.CODEX_HOME, "config.toml");
    const codeConfigPath = path.join(process.env.CODE_HOME, "config.toml");
    await fs.writeFile(codexConfigPath, 'notify = ["echo", "custom-codex"]\n', "utf8");
    await fs.writeFile(codeConfigPath, 'notify = ["echo", "custom-code"]\n', "utf8");

    process.stdout.write = () => true;
    await cmdUninstall([]);

    const codexAfter = await fs.readFile(codexConfigPath, "utf8");
    const codeAfter = await fs.readFile(codeConfigPath, "utf8");
    assert.ok(codexAfter.includes('notify = ["echo", "custom-codex"]'));
    assert.ok(codeAfter.includes('notify = ["echo", "custom-code"]'));
  } finally {
    process.stdout.write = prevWrite;
    restoreHome();
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    if (prevCodeHome === undefined) delete process.env.CODE_HOME;
    else process.env.CODE_HOME = prevCodeHome;
    if (prevOpencodeConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = prevOpencodeConfigDir;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("uninstall removes Grok Build hook and handler", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-grok-uninstall-"));
  let restoreHome = () => {};
  const prevGrokHome = process.env.GROK_HOME;
  const prevWrite = process.stdout.write;

  try {
    restoreHome = withHome(tmp);
    process.env.GROK_HOME = path.join(tmp, ".grok");
    const trackerDir = path.join(tmp, ".tokentracker", "tracker");
    const hookPath = path.join(process.env.GROK_HOME, "hooks", GROK_HOOK_FILENAME);
    const handlerPath = path.join(tmp, ".tokentracker", "bin", "grok-session-end-hook.cjs");
    const legacyHandlerPath = path.join(trackerDir, "bin", "grok-session-end-hook.cjs");

    await fs.mkdir(path.dirname(hookPath), { recursive: true });
    await fs.mkdir(path.dirname(handlerPath), { recursive: true });
    await fs.mkdir(path.dirname(legacyHandlerPath), { recursive: true });
    await fs.writeFile(
      hookPath,
      JSON.stringify({
        hooks: {
          SessionEnd: [
            { hooks: [{ type: "command", command: `/usr/bin/env node ${handlerPath}` }] },
          ],
        },
      }) + "\n",
      "utf8",
    );
    await fs.writeFile(handlerPath, "handler\n", "utf8");
    await fs.writeFile(legacyHandlerPath, "legacy handler\n", "utf8");

    process.stdout.write = () => true;
    await cmdUninstall([]);

    await assert.rejects(fs.stat(hookPath), /ENOENT/);
    await assert.rejects(fs.stat(handlerPath), /ENOENT/);
    await assert.rejects(fs.stat(legacyHandlerPath), /ENOENT/);
  } finally {
    process.stdout.write = prevWrite;
    restoreHome();
    if (prevGrokHome === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = prevGrokHome;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("init then uninstall manages Claude hooks without removing existing hooks", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-init-uninstall-"));
  let restoreHome = () => {};
  const prevCodexHome = process.env.CODEX_HOME;
  const prevToken = process.env.TOKENTRACKER_DEVICE_TOKEN;
  const prevOpencodeConfigDir = process.env.OPENCODE_CONFIG_DIR;
  const prevWrite = process.stdout.write;

  try {
    restoreHome = withHome(tmp);
    process.env.CODEX_HOME = path.join(tmp, ".codex");
    delete process.env.TOKENTRACKER_DEVICE_TOKEN;
    process.env.OPENCODE_CONFIG_DIR = path.join(tmp, ".config", "opencode");
    await fs.mkdir(process.env.CODEX_HOME, { recursive: true });

    const codexConfigPath = path.join(process.env.CODEX_HOME, "config.toml");
    await fs.writeFile(codexConfigPath, "# empty\n", "utf8");

    const claudeDir = path.join(tmp, ".claude");
    await fs.mkdir(claudeDir, { recursive: true });
    const settingsPath = path.join(claudeDir, "settings.json");
    const existingCommand = "echo existing-claude";
    const settings = {
      env: { SAMPLE: "1" },
      hooks: {
        SessionEnd: [
          {
            hooks: [{ command: existingCommand }],
          },
        ],
      },
    };
    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");

    process.stdout.write = () => true;
    await cmdInit(["--yes", "--no-auth", "--no-open", "--base-url", "https://example.invalid"]);

    const installedRaw = await fs.readFile(settingsPath, "utf8");
    const installed = JSON.parse(installedRaw);
    const hookCommand = buildClaudeHookCommand(path.join(tmp, ".tokentracker", "bin", "notify.cjs"));
    const sessionEnd = installed?.hooks?.SessionEnd || [];
    const allCommands = sessionEnd
      .flatMap((entry) => (Array.isArray(entry?.hooks) ? entry.hooks : [entry]))
      .map((h) => h?.command);
    assert.ok(allCommands.includes(existingCommand), "expected existing Claude hook to remain");
    assert.ok(allCommands.includes(hookCommand), "expected tracker Claude hook to be added");
    const stopCommands = (installed?.hooks?.Stop || [])
      .flatMap((entry) => (Array.isArray(entry?.hooks) ? entry.hooks : [entry]))
      .map((h) => h?.command);
    assert.ok(stopCommands.includes(hookCommand), "expected tracker Claude Stop hook to be added");

    await cmdUninstall([]);

    const restoredRaw = await fs.readFile(settingsPath, "utf8");
    const restored = JSON.parse(restoredRaw);
    const restoredSessionEnd = restored?.hooks?.SessionEnd || [];
    const restoredCommands = restoredSessionEnd
      .flatMap((entry) => (Array.isArray(entry?.hooks) ? entry.hooks : [entry]))
      .map((h) => h?.command);
    assert.ok(
      restoredCommands.includes(existingCommand),
      "expected existing Claude hook to remain",
    );
    assert.ok(
      !restoredCommands.includes(hookCommand),
      "expected tracker Claude hook to be removed",
    );
    const restoredStopCommands = (restored?.hooks?.Stop || [])
      .flatMap((entry) => (Array.isArray(entry?.hooks) ? entry.hooks : [entry]))
      .map((h) => h?.command);
    assert.ok(
      !restoredStopCommands.includes(hookCommand),
      "expected tracker Claude Stop hook to be removed",
    );
  } finally {
    process.stdout.write = prevWrite;
    restoreHome();
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    if (prevToken === undefined) delete process.env.TOKENTRACKER_DEVICE_TOKEN;
    else process.env.TOKENTRACKER_DEVICE_TOKEN = prevToken;
    if (prevOpencodeConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = prevOpencodeConfigDir;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("init then uninstall manages Gemini hooks without removing existing hooks", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-init-uninstall-"));
  let restoreHome = () => {};
  const prevCodexHome = process.env.CODEX_HOME;
  const prevToken = process.env.TOKENTRACKER_DEVICE_TOKEN;
  const prevOpencodeConfigDir = process.env.OPENCODE_CONFIG_DIR;
  const prevGeminiHome = process.env.GEMINI_HOME;
  const prevWrite = process.stdout.write;

  try {
    restoreHome = withHome(tmp);
    process.env.CODEX_HOME = path.join(tmp, ".codex");
    process.env.GEMINI_HOME = path.join(tmp, ".gemini");
    delete process.env.TOKENTRACKER_DEVICE_TOKEN;
    process.env.OPENCODE_CONFIG_DIR = path.join(tmp, ".config", "opencode");
    await fs.mkdir(process.env.CODEX_HOME, { recursive: true });
    await fs.mkdir(process.env.GEMINI_HOME, { recursive: true });

    const codexConfigPath = path.join(process.env.CODEX_HOME, "config.toml");
    await fs.writeFile(codexConfigPath, "# empty\n", "utf8");

    const settingsPath = path.join(process.env.GEMINI_HOME, "settings.json");
    const existingCommand = "echo existing-gemini";
    const settings = {
      tools: { enableHooks: false },
      hooks: {
        disabled: ["existing-disabled"],
        SessionEnd: [
          {
            matcher: "exit",
            hooks: [{ name: "existing-gemini", type: "command", command: existingCommand }],
          },
        ],
      },
    };
    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");

    process.stdout.write = () => true;
    await cmdInit(["--yes", "--no-auth", "--no-open", "--base-url", "https://example.invalid"]);

    const installedRaw = await fs.readFile(settingsPath, "utf8");
    const installed = JSON.parse(installedRaw);
    assert.equal(installed?.tools?.enableHooks, true);
    assert.deepEqual(installed?.hooks?.disabled, ["existing-disabled"]);
    const hookCommand = buildGeminiHookCommand(path.join(tmp, ".tokentracker", "bin", "notify.cjs"));
    const sessionEnd = installed?.hooks?.SessionEnd || [];
    const hooks = flattenHookEntries(sessionEnd);
    const allCommands = hooks.map((h) => h?.command);
    const trackerEntry = sessionEnd.find(
      (entry) =>
        Array.isArray(entry?.hooks) && entry.hooks.some((hook) => hook?.command === hookCommand),
    );
    assert.ok(allCommands.includes(existingCommand), "expected existing Gemini hook to remain");
    assert.ok(allCommands.includes(hookCommand), "expected tracker Gemini hook to be added");
    assert.equal(trackerEntry?.matcher, "exit|clear|logout|prompt_input_exit|other");

    await cmdUninstall([]);

    const restoredRaw = await fs.readFile(settingsPath, "utf8");
    const restored = JSON.parse(restoredRaw);
    assert.equal(restored?.tools?.enableHooks, true);
    assert.deepEqual(restored?.hooks?.disabled, ["existing-disabled"]);
    const restoredSessionEnd = restored?.hooks?.SessionEnd || [];
    const restoredHooks = flattenHookEntries(restoredSessionEnd);
    const restoredCommands = restoredHooks.map((h) => h?.command);
    assert.ok(
      restoredCommands.includes(existingCommand),
      "expected existing Gemini hook to remain",
    );
    assert.ok(
      !restoredCommands.includes(hookCommand),
      "expected tracker Gemini hook to be removed",
    );
  } finally {
    process.stdout.write = prevWrite;
    restoreHome();
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    if (prevToken === undefined) delete process.env.TOKENTRACKER_DEVICE_TOKEN;
    else process.env.TOKENTRACKER_DEVICE_TOKEN = prevToken;
    if (prevOpencodeConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = prevOpencodeConfigDir;
    if (prevGeminiHome === undefined) delete process.env.GEMINI_HOME;
    else process.env.GEMINI_HOME = prevGeminiHome;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("init skips Gemini hooks when config directory is missing", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-init-uninstall-"));
  let restoreHome = () => {};
  const prevCodexHome = process.env.CODEX_HOME;
  const prevToken = process.env.TOKENTRACKER_DEVICE_TOKEN;
  const prevOpencodeConfigDir = process.env.OPENCODE_CONFIG_DIR;
  const prevGeminiHome = process.env.GEMINI_HOME;
  const prevWrite = process.stdout.write;

  try {
    restoreHome = withHome(tmp);
    process.env.CODEX_HOME = path.join(tmp, ".codex");
    process.env.GEMINI_HOME = path.join(tmp, ".gemini-missing");
    delete process.env.TOKENTRACKER_DEVICE_TOKEN;
    process.env.OPENCODE_CONFIG_DIR = path.join(tmp, ".config", "opencode");
    await fs.mkdir(process.env.CODEX_HOME, { recursive: true });

    const codexConfigPath = path.join(process.env.CODEX_HOME, "config.toml");
    await fs.writeFile(codexConfigPath, "# empty\n", "utf8");

    process.stdout.write = () => true;
    await cmdInit(["--yes", "--no-auth", "--no-open", "--base-url", "https://example.invalid"]);

    await assert.rejects(fs.stat(process.env.GEMINI_HOME), /ENOENT/);
  } finally {
    process.stdout.write = prevWrite;
    restoreHome();
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    if (prevToken === undefined) delete process.env.TOKENTRACKER_DEVICE_TOKEN;
    else process.env.TOKENTRACKER_DEVICE_TOKEN = prevToken;
    if (prevOpencodeConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = prevOpencodeConfigDir;
    if (prevGeminiHome === undefined) delete process.env.GEMINI_HOME;
    else process.env.GEMINI_HOME = prevGeminiHome;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("init creates Gemini settings when directory exists but file is missing", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-init-uninstall-"));
  let restoreHome = () => {};
  const prevCodexHome = process.env.CODEX_HOME;
  const prevToken = process.env.TOKENTRACKER_DEVICE_TOKEN;
  const prevOpencodeConfigDir = process.env.OPENCODE_CONFIG_DIR;
  const prevGeminiHome = process.env.GEMINI_HOME;
  const prevWrite = process.stdout.write;

  try {
    restoreHome = withHome(tmp);
    process.env.CODEX_HOME = path.join(tmp, ".codex");
    process.env.GEMINI_HOME = path.join(tmp, ".gemini");
    delete process.env.TOKENTRACKER_DEVICE_TOKEN;
    process.env.OPENCODE_CONFIG_DIR = path.join(tmp, ".config", "opencode");
    await fs.mkdir(process.env.CODEX_HOME, { recursive: true });
    await fs.mkdir(process.env.GEMINI_HOME, { recursive: true });

    const codexConfigPath = path.join(process.env.CODEX_HOME, "config.toml");
    await fs.writeFile(codexConfigPath, "# empty\n", "utf8");

    const settingsPath = path.join(process.env.GEMINI_HOME, "settings.json");

    process.stdout.write = () => true;
    await cmdInit(["--yes", "--no-auth", "--no-open", "--base-url", "https://example.invalid"]);

    const createdRaw = await fs.readFile(settingsPath, "utf8");
    const created = JSON.parse(createdRaw);
    assert.equal(created?.tools?.enableHooks, true);
    const sessionEnd = created?.hooks?.SessionEnd || [];
    const hooks = flattenHookEntries(sessionEnd);
    const hookCommand = buildGeminiHookCommand(path.join(tmp, ".tokentracker", "bin", "notify.cjs"));
    const hasTracker = hooks.some((hook) => hook?.command === hookCommand);
    assert.ok(hasTracker, "expected tracker Gemini hook to be created in settings.json");
  } finally {
    process.stdout.write = prevWrite;
    restoreHome();
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    if (prevToken === undefined) delete process.env.TOKENTRACKER_DEVICE_TOKEN;
    else process.env.TOKENTRACKER_DEVICE_TOKEN = prevToken;
    if (prevOpencodeConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = prevOpencodeConfigDir;
    if (prevGeminiHome === undefined) delete process.env.GEMINI_HOME;
    else process.env.GEMINI_HOME = prevGeminiHome;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("init then uninstall manages Opencode plugin without removing other plugins", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-init-uninstall-"));
  let restoreHome = () => {};
  const prevCodexHome = process.env.CODEX_HOME;
  const prevToken = process.env.TOKENTRACKER_DEVICE_TOKEN;
  const prevOpencodeConfigDir = process.env.OPENCODE_CONFIG_DIR;
  const prevWrite = process.stdout.write;

  try {
    restoreHome = withHome(tmp);
    process.env.CODEX_HOME = path.join(tmp, ".codex");
    delete process.env.TOKENTRACKER_DEVICE_TOKEN;
    process.env.OPENCODE_CONFIG_DIR = path.join(tmp, ".config", "opencode");
    await fs.mkdir(process.env.CODEX_HOME, { recursive: true });

    const codexConfigPath = path.join(process.env.CODEX_HOME, "config.toml");
    await fs.writeFile(codexConfigPath, "# empty\n", "utf8");

    const opencodeDir = path.join(tmp, ".config", "opencode");
    const pluginDir = path.join(opencodeDir, "plugin");
    await fs.mkdir(pluginDir, { recursive: true });
    const existingPluginPath = path.join(pluginDir, "existing.js");
    await fs.writeFile(existingPluginPath, "// existing\n", "utf8");

    process.stdout.write = () => true;
    await cmdInit(["--yes", "--no-auth", "--no-open", "--base-url", "https://example.invalid"]);

    const pluginPath = path.join(pluginDir, "tokentracker.js");
    const installed = await fs.readFile(pluginPath, "utf8");
    assert.match(installed, /TOKENTRACKER_PLUGIN/);

    await cmdUninstall([]);

    await assert.rejects(fs.stat(pluginPath), /ENOENT/);
    const existing = await fs.readFile(existingPluginPath, "utf8");
    assert.ok(existing.includes("existing"));
  } finally {
    process.stdout.write = prevWrite;
    restoreHome();
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    if (prevToken === undefined) delete process.env.TOKENTRACKER_DEVICE_TOKEN;
    else process.env.TOKENTRACKER_DEVICE_TOKEN = prevToken;
    if (prevOpencodeConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = prevOpencodeConfigDir;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("init installs Opencode plugin when config dir is missing", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-init-uninstall-"));
  let restoreHome = () => {};
  const prevCodexHome = process.env.CODEX_HOME;
  const prevToken = process.env.TOKENTRACKER_DEVICE_TOKEN;
  const prevOpencodeConfigDir = process.env.OPENCODE_CONFIG_DIR;
  const prevWrite = process.stdout.write;

  try {
    restoreHome = withHome(tmp);
    process.env.CODEX_HOME = path.join(tmp, ".codex");
    delete process.env.TOKENTRACKER_DEVICE_TOKEN;
    process.env.OPENCODE_CONFIG_DIR = path.join(tmp, ".config", "opencode");
    await fs.mkdir(process.env.CODEX_HOME, { recursive: true });

    const codexConfigPath = path.join(process.env.CODEX_HOME, "config.toml");
    await fs.writeFile(codexConfigPath, "# empty\n", "utf8");

    process.stdout.write = () => true;
    await cmdInit(["--yes", "--no-auth", "--no-open", "--base-url", "https://example.invalid"]);

    const pluginPath = path.join(process.env.OPENCODE_CONFIG_DIR, "plugin", "tokentracker.js");
    const installed = await fs.readFile(pluginPath, "utf8");
    assert.match(installed, /TOKENTRACKER_PLUGIN/);
  } finally {
    process.stdout.write = prevWrite;
    restoreHome();
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    if (prevToken === undefined) delete process.env.TOKENTRACKER_DEVICE_TOKEN;
    else process.env.TOKENTRACKER_DEVICE_TOKEN = prevToken;
    if (prevOpencodeConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = prevOpencodeConfigDir;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
