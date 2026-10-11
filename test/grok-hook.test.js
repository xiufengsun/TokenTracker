const assert = require("node:assert/strict");
const cp = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");
const { test } = require("node:test");

const {
  GROK_HOOK_FILENAME,
  buildGrokSessionEndHookJson,
  buildGrokSessionEndHandler,
  probeGrokHookState,
  resolveGrokHome,
  upsertGrokHook,
} = require("../src/lib/grok-hook");

test("resolveGrokHome prefers TokenTracker-prefixed override", () => {
  assert.equal(
    resolveGrokHome({
      TOKENTRACKER_GROK_HOME: "/tmp/tokentracker-grok",
      GROK_HOME: "/tmp/legacy-grok",
    }),
    "/tmp/tokentracker-grok",
  );
  assert.equal(resolveGrokHome({ GROK_HOME: "/tmp/legacy-grok" }), "/tmp/legacy-grok");
});

test("generated Grok handler skips malformed numeric signal fields", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-grok-handler-nan-"));
  try {
    const trackerDir = path.join(tmp, ".tokentracker", "tracker");
    const grokHome = path.join(tmp, ".grok");
    const workspaceRoot = path.join(tmp, "project");
    const sessionId = "grok-session-nan";
    const sessionDir = path.join(grokHome, "sessions", encodeURIComponent(workspaceRoot), sessionId);
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionDir, "signals.json"),
      JSON.stringify({
        contextTokensUsed: "definitely-not-a-number",
        assistantMessageCount: 2,
        primaryModelId: "grok-build",
      }),
      "utf8",
    );

    const handlerPath = path.join(tmp, "grok-session-end-hook.cjs");
    await fs.writeFile(handlerPath, buildGrokSessionEndHandler({ trackerDir }), "utf8");

    const result = cp.spawnSync(process.execPath, [handlerPath], {
      env: {
        ...process.env,
        GROK_HOME: grokHome,
        GROK_SESSION_ID: sessionId,
        GROK_WORKSPACE_ROOT: workspaceRoot,
      },
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    await assert.rejects(fs.stat(path.join(trackerDir, "grok-last-session.json")), /ENOENT/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("generated Grok handler writes session paths and update telemetry", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-grok-handler-updates-"));
  try {
    const trackerDir = path.join(tmp, ".tokentracker", "tracker");
    const grokHome = path.join(tmp, ".grok");
    const workspaceRoot = path.join(tmp, "project");
    const sessionId = "grok-session-updates";
    const sessionDir = path.join(grokHome, "sessions", encodeURIComponent(workspaceRoot), sessionId);
    const signalsPath = path.join(sessionDir, "signals.json");
    const summaryPath = path.join(sessionDir, "summary.json");
    const updatesPath = path.join(sessionDir, "updates.jsonl");
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      signalsPath,
      JSON.stringify({
        contextTokensUsed: 50,
        totalTokensBeforeCompaction: 10,
        assistantMessageCount: 2,
        primaryModelId: "grok-build",
        lastActiveAt: "2026-04-05T14:20:00.000Z",
      }),
      "utf8",
    );
    await fs.writeFile(summaryPath, JSON.stringify({ updated_at: "2026-04-05T14:10:00.000Z" }), "utf8");
    await fs.writeFile(
      updatesPath,
      JSON.stringify({
        method: "session/update",
        params: {
          _meta: {
            totalTokens: 120,
            agentTimestampMs: Date.parse("2026-04-05T14:15:00.000Z"),
            eventId: "evt-120",
          },
        },
      }) + "\n",
      "utf8",
    );

    const handlerPath = path.join(tmp, "grok-session-end-hook.cjs");
    await fs.writeFile(handlerPath, buildGrokSessionEndHandler({ trackerDir }), "utf8");

    const result = cp.spawnSync(process.execPath, [handlerPath], {
      env: {
        ...process.env,
        GROK_HOME: grokHome,
        GROK_SESSION_ID: sessionId,
        GROK_WORKSPACE_ROOT: workspaceRoot,
      },
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    const signal = JSON.parse(await fs.readFile(path.join(trackerDir, "grok-last-session.json"), "utf8"));
    assert.equal(signal.totalTokens, 120);
    assert.equal(signal.contextTokensUsed, 50);
    assert.equal(signal.totalTokensBeforeCompaction, 10);
    assert.equal(signal.messageCount, 2);
    assert.equal(signal.sessionDir, sessionDir);
    assert.equal(signal.signalsPath, signalsPath);
    assert.equal(signal.summaryPath, summaryPath);
    assert.equal(signal.updatesPath, updatesPath);
    assert.equal(signal.lastEventId, "evt-120");
    assert.equal(signal.lastEventTimestamp, "2026-04-05T14:15:00.000Z");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("generated Grok handler preserves zero context after compaction", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-grok-handler-zero-context-"));
  try {
    const trackerDir = path.join(tmp, ".tokentracker", "tracker");
    const grokHome = path.join(tmp, ".grok");
    const workspaceRoot = path.join(tmp, "project");
    const sessionId = "grok-session-zero-context";
    const sessionDir = path.join(grokHome, "sessions", encodeURIComponent(workspaceRoot), sessionId);
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionDir, "signals.json"),
      JSON.stringify({
        contextTokensUsed: 0,
        totalTokensBeforeCompaction: 500,
        totalTokens: 500,
        assistantMessageCount: 3,
        primaryModelId: "grok-build",
        lastActiveAt: "2026-04-05T15:20:00.000Z",
      }),
      "utf8",
    );

    const handlerPath = path.join(tmp, "grok-session-end-hook.cjs");
    await fs.writeFile(handlerPath, buildGrokSessionEndHandler({ trackerDir }), "utf8");

    const result = cp.spawnSync(process.execPath, [handlerPath], {
      env: {
        ...process.env,
        GROK_HOME: grokHome,
        GROK_SESSION_ID: sessionId,
        GROK_WORKSPACE_ROOT: workspaceRoot,
      },
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    const signal = JSON.parse(await fs.readFile(path.join(trackerDir, "grok-last-session.json"), "utf8"));
    assert.equal(signal.contextTokensUsed, 0);
    assert.equal(signal.totalTokensBeforeCompaction, 500);
    assert.equal(signal.totalTokens, 500);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("buildGrokSessionEndHookJson quotes handler paths for shell command", () => {
  const hookJson = buildGrokSessionEndHookJson({
    notifyGrokHandlerPath: "/tmp/Token Tracker's/bin/grok-session-end-hook.cjs",
  }, { platform: "linux" });

  assert.equal(
    hookJson.hooks.SessionEnd[0].hooks[0].command,
    "/usr/bin/env node '/tmp/Token Tracker'\\''s/bin/grok-session-end-hook.cjs'",
  );
});

test("buildGrokSessionEndHookJson uses the Node executable on Windows", () => {
  const hookJson = buildGrokSessionEndHookJson(
    {
      notifyGrokHandlerPath: "C:\\Users\\Ricky\\Token Tracker\\grok-session-end-hook.cjs",
    },
    {
      platform: "win32",
      execPath: "C:\\Program Files\\nodejs\\node.exe",
    },
  );

  const command = hookJson.hooks.SessionEnd[0].hooks[0].command;
  assert.equal(
    command,
    '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\Ricky\\Token Tracker\\grok-session-end-hook.cjs"',
  );
  assert.ok(!command.includes("/usr/bin/env"));
});

test("upsertGrokHook writes handler to canonical tokentracker bin dir", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-grok-hook-"));
  try {
    const trackerDir = path.join(tmp, ".tokentracker", "tracker");
    const grokHome = path.join(tmp, ".grok");

    const result = await upsertGrokHook({
      home: tmp,
      trackerDir,
      env: { GROK_HOME: grokHome },
    });

    const hookPath = path.join(grokHome, "hooks", GROK_HOOK_FILENAME);
    const handlerPath = path.join(tmp, ".tokentracker", "bin", "grok-session-end-hook.cjs");
    const legacyHandlerPath = path.join(trackerDir, "bin", "grok-session-end-hook.cjs");

    assert.equal(result.hookPath, hookPath);
    assert.equal(result.handlerPath, handlerPath);
    const hookJson = JSON.parse(await fs.readFile(hookPath, "utf8"));
    assert.ok(hookJson.hooks.SessionEnd[0].hooks[0].command.includes(handlerPath));
    await fs.stat(handlerPath);
    await assert.rejects(fs.stat(legacyHandlerPath), /ENOENT/);

    const state = await probeGrokHookState({
      home: tmp,
      trackerDir,
      env: { GROK_HOME: grokHome },
    });
    assert.equal(state.configured, true);
    assert.equal(state.handlerExists, true);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
