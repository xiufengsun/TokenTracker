const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");
const { test } = require("node:test");

const { cmdDiagnostics } = require("../src/commands/diagnostics");
const { collectTrackerDiagnostics } = require("../src/lib/diagnostics");
const { withHome } = require("./helpers/with-home");

test("diagnostics redacts device token and home paths", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-diagnostics-"));
  let restoreHome = () => {};
  const prevCodexHome = process.env.CODEX_HOME;
  const prevTokenTrackerGrokHome = process.env.TOKENTRACKER_GROK_HOME;
  const prevGrokHome = process.env.GROK_HOME;
  const prevWrite = process.stdout.write;

  try {
    restoreHome = withHome(tmp);
    process.env.CODEX_HOME = path.join(tmp, ".codex");
    delete process.env.TOKENTRACKER_GROK_HOME;
    process.env.GROK_HOME = path.join(tmp, ".grok");

    const trackerDir = path.join(tmp, ".tokentracker", "tracker");
    const grokHandlerPath = path.join(tmp, ".tokentracker", "bin", "grok-session-end-hook.cjs");
    const grokHookPath = path.join(process.env.GROK_HOME, "hooks", "99-tokentracker-usage.json");
    await fs.mkdir(trackerDir, { recursive: true });
    await fs.mkdir(process.env.CODEX_HOME, { recursive: true });
    await fs.mkdir(path.dirname(grokHandlerPath), { recursive: true });
    await fs.mkdir(path.dirname(grokHookPath), { recursive: true });

    const secret = "super_secret_device_token";
    await fs.writeFile(
      path.join(trackerDir, "config.json"),
      JSON.stringify(
        {
          baseUrl: "https://example.invalid",
          deviceToken: secret,
          deviceId: "11111111-1111-1111-1111-111111111111",
          installedAt: "2025-12-19T00:00:00.000Z",
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    await fs.writeFile(
      path.join(process.env.CODEX_HOME, "config.toml"),
      `notify = ["/usr/bin/env", "node", "${path.join(tmp, ".tokentracker", "bin", "notify.cjs")}"]\n`,
      "utf8",
    );
    await fs.writeFile(grokHandlerPath, "handler\n", "utf8");
    await fs.writeFile(
      grokHookPath,
      JSON.stringify({
        hooks: {
          SessionEnd: [
            { hooks: [{ type: "command", command: `/usr/bin/env node ${grokHandlerPath}` }] },
          ],
        },
      }) + "\n",
      "utf8",
    );

    const retryAtMs = Date.now() + 60_000;
    await fs.writeFile(
      path.join(trackerDir, "openclaw.signal"),
      "2026-02-12T00:00:00.000Z\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(trackerDir, "auto.retry.json"),
      JSON.stringify(
        {
          version: 1,
          retryAtMs,
          retryAt: new Date(retryAtMs).toISOString(),
          reason: "throttled",
          pendingBytes: 123,
          scheduledAt: "2025-12-23T00:00:00.000Z",
          source: "auto",
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    let out = "";
    process.stdout.write = (chunk, enc, cb) => {
      out += typeof chunk === "string" ? chunk : chunk.toString(enc || "utf8");
      if (typeof cb === "function") cb();
      return true;
    };

    await cmdDiagnostics([]);

    assert.ok(!out.includes(secret), "expected device token to be redacted");
    assert.ok(!out.includes(tmp), "expected home path to be redacted");

    const data = JSON.parse(out);
    assert.equal(data?.config?.device_token, "set");
    assert.equal(data?.notify?.last_openclaw_triggered_sync, "2026-02-12T00:00:00.000Z");
    assert.equal(data?.notify?.openclaw_session_plugin_conversation_access, false);
    assert.equal(data?.notify?.grok_hook_configured, true);
    assert.equal(data?.notify?.grok_hook_handler_exists, true);
    assert.equal(typeof data?.paths?.codex_home, "string");
    assert.ok(String(data.paths.codex_home).startsWith("~"));
    assert.equal(typeof data?.paths?.grok_home, "string");
    assert.ok(String(data.paths.grok_home).startsWith("~"));
    assert.equal(data?.auto_retry?.reason, "throttled");
    assert.equal(data?.auto_retry?.pending_bytes, 123);
    assert.equal(data?.auto_retry?.next_retry_at, new Date(retryAtMs).toISOString());
  } finally {
    process.stdout.write = prevWrite;
    restoreHome();
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    if (prevTokenTrackerGrokHome === undefined) delete process.env.TOKENTRACKER_GROK_HOME;
    else process.env.TOKENTRACKER_GROK_HOME = prevTokenTrackerGrokHome;
    if (prevGrokHome === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = prevGrokHome;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("diagnostics reports TokenTracker-prefixed Grok home override", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-diagnostics-grok-"));
  const prevTokenTrackerGrokHome = process.env.TOKENTRACKER_GROK_HOME;
  const prevGrokHome = process.env.GROK_HOME;
  try {
    process.env.TOKENTRACKER_GROK_HOME = path.join(tmp, ".grok-prefixed");
    process.env.GROK_HOME = path.join(tmp, ".grok-legacy");

    const data = await collectTrackerDiagnostics({ home: tmp });

    assert.equal(data.paths.grok_home, path.join("~", ".grok-prefixed"));
  } finally {
    if (prevTokenTrackerGrokHome === undefined) delete process.env.TOKENTRACKER_GROK_HOME;
    else process.env.TOKENTRACKER_GROK_HOME = prevTokenTrackerGrokHome;
    if (prevGrokHome === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = prevGrokHome;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("diagnostics does not migrate legacy root", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-diagnostics-"));
  const home = path.join(tmp, "home");
  await fs.mkdir(home, { recursive: true });
  const legacyRoot = path.join(home, ".legacy-tracker-root");
  await fs.mkdir(path.join(legacyRoot, "tracker"), { recursive: true });

  await collectTrackerDiagnostics({ home });

  await fs.stat(legacyRoot);
  await assert.rejects(() => fs.stat(path.join(home, ".tokentracker")));
});
