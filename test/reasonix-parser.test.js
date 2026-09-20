"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  parseReasonixIncremental,
  normalizeReasonixModel,
  resolveReasonixTelemetryFiles,
} = require("../src/lib/rollout");

function writeSession(home, id, usage, model = "deepseek/deepseek-reasoner") {
  const sessions = path.join(home, ".reasonix", "projects", "project-a", "sessions");
  fs.mkdirSync(sessions, { recursive: true });
  const base = path.join(sessions, `${id}.jsonl`);
  fs.writeFileSync(`${base}.telemetry.json`, JSON.stringify({ version: 2, usage }));
  fs.writeFileSync(`${base}.meta`, JSON.stringify({
    id,
    model,
    updated_at: "2026-08-12T03:12:00Z",
  }));
  return `${base}.telemetry.json`;
}

function readRows(queuePath) {
  if (!fs.existsSync(queuePath)) return [];
  return fs.readFileSync(queuePath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
}

test("resolveReasonixTelemetryFiles discovers content-free session sidecars", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-reasonix-home-"));
  try {
    const telemetryPath = writeSession(home, "session-1", { promptTokens: 1 });
    assert.deepEqual(resolveReasonixTelemetryFiles({ HOME: home }), [telemetryPath]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("normalizeReasonixModel strips the routing profile prefix", () => {
  assert.equal(
    normalizeReasonixModel("基元律动-雷/deepseek-v4-flash-0731"),
    "deepseek-v4-flash-0731",
  );
  assert.equal(normalizeReasonixModel("deepseek-reasoner"), "deepseek-reasoner");
});

test("parseReasonixIncremental maps cache and reasoning without double-counting", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-reasonix-parse-"));
  const queuePath = path.join(home, "queue.jsonl");
  const cursors = {};
  try {
    const telemetryPath = writeSession(home, "session-1", {
      promptTokens: 1_000,
      cacheHitTokens: 800,
      cacheMissTokens: 200,
      cacheWriteTokens: 60,
      completionTokens: 300,
      reasoningTokens: 120,
      requestCount: 2,
    });
    const first = await parseReasonixIncremental({ telemetryFiles: [telemetryPath], cursors, queuePath });
    const [row] = readRows(queuePath);
    assert.deepEqual(first, { recordsProcessed: 1, eventsAggregated: 1, bucketsQueued: 1 });
    assert.equal(row.source, "reasonix");
    assert.equal(row.model, "deepseek-reasoner");
    assert.equal(row.input_tokens, 140);
    assert.equal(row.cached_input_tokens, 800);
    assert.equal(row.cache_creation_input_tokens, 60);
    assert.equal(row.output_tokens, 180);
    assert.equal(row.reasoning_output_tokens, 120);
    assert.equal(row.total_tokens, 1_300);
    assert.equal(row.conversation_count, 2);

    const second = await parseReasonixIncremental({ telemetryFiles: [telemetryPath], cursors, queuePath });
    assert.deepEqual(second, { recordsProcessed: 1, eventsAggregated: 0, bucketsQueued: 0 });
    assert.equal(readRows(queuePath).length, 1);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("parseReasonixIncremental emits only cumulative growth", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-reasonix-delta-"));
  const queuePath = path.join(home, "queue.jsonl");
  const cursors = {};
  try {
    const telemetryPath = writeSession(home, "session-1", {
      promptTokens: 60,
      cacheHitTokens: 50,
      cacheMissTokens: 10,
      completionTokens: 20,
      reasoningTokens: 5,
      requestCount: 1,
    });
    await parseReasonixIncremental({ telemetryFiles: [telemetryPath], cursors, queuePath });
    writeSession(home, "session-1", {
      promptTokens: 105,
      cacheHitTokens: 90,
      cacheMissTokens: 15,
      completionTokens: 32,
      reasoningTokens: 8,
      requestCount: 2,
    });
    await parseReasonixIncremental({ telemetryFiles: [telemetryPath], cursors, queuePath });
    const latest = readRows(queuePath).at(-1);
    assert.equal(latest.input_tokens, 15);
    assert.equal(latest.cached_input_tokens, 90);
    assert.equal(latest.output_tokens, 24);
    assert.equal(latest.reasoning_output_tokens, 8);
    assert.equal(latest.total_tokens, 137);
    assert.equal(latest.conversation_count, 2);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("parseReasonixIncremental preserves request-only cumulative growth", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-reasonix-requests-"));
  const queuePath = path.join(home, "queue.jsonl");
  const cursors = {};
  try {
    const usage = {
      promptTokens: 10,
      cacheMissTokens: 10,
      completionTokens: 2,
      reasoningTokens: 1,
      requestCount: 1,
    };
    const telemetryPath = writeSession(home, "session-1", usage);
    await parseReasonixIncremental({ telemetryFiles: [telemetryPath], cursors, queuePath });

    writeSession(home, "session-1", { ...usage, requestCount: 2 });
    const second = await parseReasonixIncremental({ telemetryFiles: [telemetryPath], cursors, queuePath });
    assert.deepEqual(second, { recordsProcessed: 1, eventsAggregated: 1, bucketsQueued: 1 });
    assert.equal(readRows(queuePath).at(-1).conversation_count, 2);

    const third = await parseReasonixIncremental({ telemetryFiles: [telemetryPath], cursors, queuePath });
    assert.deepEqual(third, { recordsProcessed: 1, eventsAggregated: 0, bucketsQueued: 0 });
    assert.equal(readRows(queuePath).length, 2);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("parseReasonixIncremental bounds inconsistent estimated cache totals", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-reasonix-estimated-"));
  const queuePath = path.join(home, "queue.jsonl");
  try {
    const telemetryPath = writeSession(home, "recovery", {
      promptTokens: 1_000,
      cacheHitTokens: 5_000,
      cacheMissTokens: 100,
      completionTokens: 50,
      reasoningTokens: 20,
      requestCount: 1,
      estimated: true,
    });
    await parseReasonixIncremental({ telemetryFiles: [telemetryPath], cursors: {}, queuePath });
    const [row] = readRows(queuePath);
    assert.equal(row.input_tokens, 100);
    assert.equal(row.cached_input_tokens, 900);
    assert.equal(row.total_tokens, 1_050);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// Git Bash / MSYS / conda on Windows export a HOME of their own, so preferring
// it sends the Reasonix scan to a directory that does not exist -- and because
// `status` only prints a Reasonix line when the home resolves, the user sees no
// data and no explanation (issue #641).
test("reasonix: Windows resolves the home from USERPROFILE, not a shell-provided HOME", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reasonix-win-"));
  const profile = path.join(root, "profile");
  const bogusHome = path.join(root, "msys-home");
  fs.mkdirSync(bogusHome, { recursive: true });
  const telemetry = writeSession(profile, "s1", {
    input_tokens: 10,
    output_tokens: 5,
    total_tokens: 15,
  });

  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  try {
    const found = resolveReasonixTelemetryFiles({ HOME: bogusHome, USERPROFILE: profile });
    assert.deepEqual(found, [telemetry], "USERPROFILE must win over a shell HOME on win32");
  } finally {
    if (descriptor) Object.defineProperty(process, "platform", descriptor);
  }

  // Explicit overrides still take precedence over both.
  const override = resolveReasonixTelemetryFiles({
    TOKENTRACKER_REASONIX_HOME: path.join(profile, ".reasonix"),
    HOME: bogusHome,
  });
  assert.deepEqual(override, [telemetry]);

  fs.rmSync(root, { recursive: true, force: true });
});
