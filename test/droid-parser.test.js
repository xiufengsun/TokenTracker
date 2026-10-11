/**
 * Droid (Factory CLI) parser test.
 *
 * Builds synthetic ~/.factory/sessions/<project>/<id>.settings.json fixtures
 * and verifies:
 *   - resolveDroidSessionsDir env precedence (DROID_SESSIONS_DIR → FACTORY_DIR → ~/.factory/sessions)
 *   - normalizeDroidModelName strips `custom:` + `[…]` brackets and dash-normalizes
 *   - listDroidSettingsFiles walks subdirectories
 *   - parseDroidIncremental emits cumulative-delta (idempotent + grows correctly)
 *   - cache, thinking, input, output tokens map to the right queue fields
 *   - settings.json with no tokenUsage / shrinking tokens / empty model handled
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const {
  resolveDroidSessionsDir,
  resolveDroidSessionsDirs,
  listDroidSettingsFiles,
  normalizeDroidModelName,
  normalizeDroidProvider,
  inferDroidProviderFromModel,
  defaultDroidModelForProvider,
  droidSessionIdFromPath,
  extractDroidModelFromSidecarJsonl,
  applyDroidTotalFallback,
  dedupeDroidSettingsFilesBySession,
  parseDroidIncremental,
} = require("../src/lib/rollout");

function makeSessionsRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "droid-test-"));
}

function writeSettings(sessionsRoot, project, id, payload, mtimeMs) {
  const dir = path.join(sessionsRoot, project);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${id}.settings.json`);
  fs.writeFileSync(filePath, JSON.stringify(payload));
  if (typeof mtimeMs === "number") {
    const t = new Date(mtimeMs);
    fs.utimesSync(filePath, t, t);
  }
  return filePath;
}

function readQueue(queuePath) {
  if (!fs.existsSync(queuePath)) return [];
  return fs
    .readFileSync(queuePath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
}

test("resolveDroidSessionsDir env precedence", () => {
  assert.equal(
    resolveDroidSessionsDir({ DROID_SESSIONS_DIR: "/x/y/sessions" }),
    "/x/y/sessions",
  );
  assert.equal(
    resolveDroidSessionsDir({ FACTORY_DIR: "/opt/factory" }),
    path.join("/opt/factory", "sessions"),
  );
  // Comma-separated → first wins for resolveDroidSessionsDir.
  assert.deepEqual(
    resolveDroidSessionsDirs({ DROID_SESSIONS_DIR: "/a, /b , /c" }),
    ["/a", "/b", "/c"],
  );
  // Default falls under ~/.factory/sessions
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "droid-default-home-"));
  const expected = path.join(home, ".factory", "sessions");
  try {
    fs.mkdirSync(expected, { recursive: true });
    const def = resolveDroidSessionsDir({ HOME: home, TOKENTRACKER_WSL: "native-only" });
    assert.equal(def, expected);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("normalizeDroidModelName strips wrapper + brackets, lowercases, dash-normalizes", () => {
  assert.equal(normalizeDroidModelName("custom:GLM-5.1-[Proxy]-0"), "glm-5-1-0");
  assert.equal(normalizeDroidModelName("custom:GLM-5.1-[Proxy]"), "glm-5-1");
  assert.equal(
    normalizeDroidModelName("claude-sonnet-4-5"),
    "claude-sonnet-4-5",
  );
  assert.equal(
    normalizeDroidModelName("anthropic/claude-opus-4-6"),
    "anthropic/claude-opus-4-6",
  );
  // ccusage parity: underscores are preserved verbatim. Replacing them would
  // split `glm_5_1` from ccusage's identically-named bucket.
  assert.equal(normalizeDroidModelName("glm_5_1"), "glm_5_1");
  assert.equal(normalizeDroidModelName("custom:GLM_5_1"), "glm_5_1");
  assert.equal(normalizeDroidModelName(""), "");
  assert.equal(normalizeDroidModelName(undefined), "");
  assert.equal(normalizeDroidModelName("[Proxy]"), "");
});

test("normalizeDroidProvider folds aliases, ccusage parity", () => {
  assert.equal(normalizeDroidProvider("claude"), "anthropic");
  assert.equal(normalizeDroidProvider("anthropic"), "anthropic");
  assert.equal(normalizeDroidProvider("openai"), "openai");
  assert.equal(normalizeDroidProvider("Google-AI"), "google");
  assert.equal(normalizeDroidProvider("vertex_ai"), "google");
  assert.equal(normalizeDroidProvider("Grok"), "xai");
  assert.equal(normalizeDroidProvider("x-ai"), "xai");
  assert.equal(normalizeDroidProvider(""), "unknown");
  assert.equal(normalizeDroidProvider(undefined), "unknown");
});

test("inferDroidProviderFromModel matches ccusage substring heuristics", () => {
  assert.equal(inferDroidProviderFromModel("claude-sonnet-4-5"), "anthropic");
  assert.equal(inferDroidProviderFromModel("opus-4-6"), "anthropic");
  assert.equal(inferDroidProviderFromModel("gpt-5.4"), "openai");
  assert.equal(inferDroidProviderFromModel("chatgpt-4o"), "openai");
  assert.equal(inferDroidProviderFromModel("o3-mini"), "openai");
  assert.equal(inferDroidProviderFromModel("gemini-2-0-flash"), "google");
  assert.equal(inferDroidProviderFromModel("grok-4-fast"), "xai");
  assert.equal(inferDroidProviderFromModel("glm-5-1"), "unknown");
  assert.equal(inferDroidProviderFromModel(""), "unknown");
});

test("defaultDroidModelForProvider maps to ccusage's `<family>-unknown` names", () => {
  assert.equal(defaultDroidModelForProvider("anthropic"), "claude-unknown");
  assert.equal(defaultDroidModelForProvider("openai"), "gpt-unknown");
  assert.equal(defaultDroidModelForProvider("google"), "gemini-unknown");
  assert.equal(defaultDroidModelForProvider("xai"), "grok-unknown");
  assert.equal(defaultDroidModelForProvider("unknown"), "unknown");
  assert.equal(defaultDroidModelForProvider("something-else"), "unknown");
});

test("droidSessionIdFromPath strips suffix, ignores non-droid paths", () => {
  assert.equal(
    droidSessionIdFromPath("/x/y/abc-123.settings.json"),
    "abc-123",
  );
  assert.equal(droidSessionIdFromPath("/x/y/abc.jsonl"), "");
  assert.equal(droidSessionIdFromPath(""), "");
});

test("listDroidSettingsFiles walks subdirectories and ignores non-settings files", () => {
  const root = makeSessionsRoot();
  writeSettings(root, "proj-a", "sess-1", { tokenUsage: {} });
  writeSettings(root, "proj-a", "sess-2", { tokenUsage: {} });
  writeSettings(root, "proj-b/nested", "sess-3", { tokenUsage: {} });
  // Sibling .jsonl, README — should be skipped
  fs.writeFileSync(path.join(root, "proj-a", "sess-1.jsonl"), "");
  fs.writeFileSync(path.join(root, "README.md"), "");

  const files = listDroidSettingsFiles({ DROID_SESSIONS_DIR: root });
  assert.equal(files.length, 3);
  for (const f of files) assert.match(f, /\.settings\.json$/);
});

test("parseDroidIncremental emits a queue row per session with delta tokens", async () => {
  const root = makeSessionsRoot();
  const queuePath = path.join(root, "queue.jsonl");
  const t1 = Date.UTC(2026, 4, 21, 14, 5, 0); // 2026-05-21T14:05:00Z → bucket 14:00
  writeSettings(
    root,
    "proj",
    "sess-1",
    {
      model: "custom:GLM-5.1-[Proxy]-0",
      providerLock: "anthropic",
      tokenUsage: {
        inputTokens: 1000,
        outputTokens: 200,
        cacheCreationTokens: 50,
        cacheReadTokens: 300,
        thinkingTokens: 80,
      },
    },
    t1,
  );

  const cursors = {};
  const res = await parseDroidIncremental({
    settingsFiles: listDroidSettingsFiles({ DROID_SESSIONS_DIR: root }),
    cursors,
    queuePath,
  });
  assert.equal(res.eventsAggregated, 1);

  const rows = readQueue(queuePath).filter((r) => r.source === "droid");
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.model, "glm-5-1-0");
  assert.equal(row.input_tokens, 1000);
  assert.equal(row.output_tokens, 200);
  assert.equal(row.cache_creation_input_tokens, 50);
  assert.equal(row.cached_input_tokens, 300);
  assert.equal(row.reasoning_output_tokens, 80);
  assert.equal(row.total_tokens, 1000 + 200 + 50 + 300 + 80);
  assert.equal(row.hour_start, "2026-05-21T14:00:00.000Z");
  // Cursor records the cumulative total keyed by session id (filename
  // minus `.settings.json`), not the absolute path.
  const sessionTotals = cursors.droid.sessionTotals;
  assert.ok(sessionTotals["sess-1"], "expected sess-1 cursor entry");
  assert.equal(sessionTotals["sess-1"].input, 1000);
  assert.equal(sessionTotals["sess-1"].thinking, 80);
});

test("parseDroidIncremental backfills project usage from the sidecar session cwd", async () => {
  const root = makeSessionsRoot();
  const sessionsRoot = path.join(root, "factory", "sessions");
  const repoDir = path.join(root, "repo-with-dash");
  const queuePath = path.join(root, "queue.jsonl");
  const projectQueuePath = path.join(root, "project.queue.jsonl");
  const t1 = Date.UTC(2026, 6, 31, 5, 30, 0);

  fs.mkdirSync(path.join(repoDir, ".git"), { recursive: true });
  fs.writeFileSync(
    path.join(repoDir, ".git", "config"),
    '[remote "origin"]\n\turl = https://github.com/acme/repo-with-dash.git\n',
  );

  const settingsPath = writeSettings(
    sessionsRoot,
    "-C-Users-Ricky-Desktop-repo-with-dash",
    "sess-project",
    {
      model: "kimi-k3",
      tokenUsage: {
        inputTokens: 1000,
        outputTokens: 200,
        cacheCreationTokens: 50,
        cacheReadTokens: 300,
        thinkingTokens: 80,
      },
    },
    t1,
  );
  fs.writeFileSync(
    settingsPath.replace(/\.settings\.json$/, ".jsonl"),
    `${JSON.stringify({ type: "session_start", id: "sess-project", cwd: repoDir })}\n`,
  );

  const cursors = {};
  await parseDroidIncremental({
    settingsFiles: [settingsPath],
    cursors,
    queuePath,
  });
  const globalRowsBefore = readQueue(queuePath).length;

  const result = await parseDroidIncremental({
    settingsFiles: [settingsPath],
    cursors,
    queuePath,
    projectQueuePath,
  });

  assert.equal(readQueue(queuePath).length, globalRowsBefore, "project backfill must not re-emit global usage");
  assert.equal(result.projectBucketsQueued, 1);
  const projectRows = readQueue(projectQueuePath);
  assert.equal(projectRows.length, 1);
  assert.equal(projectRows[0].project_key, "acme/repo-with-dash");
  assert.equal(projectRows[0].project_ref, "https://github.com/acme/repo-with-dash");
  assert.equal(projectRows[0].source, "droid");
  assert.equal(projectRows[0].total_tokens, 1630);

  const unchanged = await parseDroidIncremental({
    settingsFiles: [settingsPath],
    cursors,
    queuePath,
    projectQueuePath,
  });
  assert.equal(unchanged.bucketsQueued, 0);
  assert.equal(unchanged.projectBucketsQueued, 0);
  assert.equal(readQueue(queuePath).length, globalRowsBefore);
  assert.equal(readQueue(projectQueuePath).length, 1);

  writeSettings(
    sessionsRoot,
    "-C-Users-Ricky-Desktop-repo-with-dash",
    "sess-project",
    {
      model: "kimi-k3",
      tokenUsage: {
        inputTokens: 1100,
        outputTokens: 220,
        cacheCreationTokens: 50,
        cacheReadTokens: 330,
        thinkingTokens: 90,
      },
    },
    t1 + 60_000,
  );
  const growth = await parseDroidIncremental({
    settingsFiles: [settingsPath],
    cursors,
    queuePath,
    projectQueuePath,
  });
  assert.equal(growth.bucketsQueued, 1);
  assert.equal(growth.projectBucketsQueued, 1);
  assert.equal(readQueue(queuePath).at(-1).total_tokens, 1790);
  assert.equal(readQueue(projectQueuePath).at(-1).total_tokens, 1790);
});

test("parseDroidIncremental cumulative-delta: second sync emits only growth", async () => {
  const root = makeSessionsRoot();
  const queuePath = path.join(root, "queue.jsonl");
  const t1 = Date.UTC(2026, 4, 21, 14, 5, 0);
  const filePath = writeSettings(
    root,
    "proj",
    "sess-1",
    {
      model: "claude-sonnet-4-5",
      tokenUsage: {
        inputTokens: 1000,
        outputTokens: 200,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        thinkingTokens: 0,
      },
    },
    t1,
  );

  const cursors = {};
  await parseDroidIncremental({
    settingsFiles: [filePath],
    cursors,
    queuePath,
  });

  // First sync: full 1000/200 emitted.
  const firstRows = readQueue(queuePath).filter((r) => r.source === "droid");
  assert.equal(firstRows.length, 1);
  assert.equal(firstRows[0].input_tokens, 1000);
  assert.equal(firstRows[0].conversation_count, 1);

  // Rewrite with higher cumulative, new mtime, then sync again.
  const t2 = Date.UTC(2026, 4, 21, 14, 35, 0); // bucket 14:30
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      model: "claude-sonnet-4-5",
      tokenUsage: {
        inputTokens: 1500,
        outputTokens: 350,
        cacheCreationTokens: 100,
        cacheReadTokens: 0,
        thinkingTokens: 0,
      },
    }),
  );
  const t2d = new Date(t2);
  fs.utimesSync(filePath, t2d, t2d);

  await parseDroidIncremental({
    settingsFiles: [filePath],
    cursors,
    queuePath,
  });
  const allRows = readQueue(queuePath).filter((r) => r.source === "droid");
  // First row 14:00 unchanged, second emitted at 14:30 with delta (500/150/100)
  const secondBucket = allRows.find((r) => r.hour_start === "2026-05-21T14:30:00.000Z");
  assert.ok(secondBucket, "expected a row at 14:30");
  assert.equal(secondBucket.input_tokens, 500);
  assert.equal(secondBucket.output_tokens, 150);
  assert.equal(secondBucket.cache_creation_input_tokens, 100);
  assert.equal(secondBucket.conversation_count, 0);
});

test("parseDroidIncremental: idempotent re-run on unchanged settings file emits nothing", async () => {
  const root = makeSessionsRoot();
  const queuePath = path.join(root, "queue.jsonl");
  const t1 = Date.UTC(2026, 4, 21, 14, 5, 0);
  const filePath = writeSettings(
    root,
    "proj",
    "sess-1",
    {
      model: "claude-sonnet-4-5",
      tokenUsage: { inputTokens: 100, outputTokens: 50 },
    },
    t1,
  );

  const cursors = {};
  const first = await parseDroidIncremental({
    settingsFiles: [filePath],
    cursors,
    queuePath,
  });
  assert.equal(first.eventsAggregated, 1);

  const second = await parseDroidIncremental({
    settingsFiles: [filePath],
    cursors,
    queuePath,
  });
  assert.equal(second.eventsAggregated, 0);
});

test("parseDroidIncremental: skips files with no tokenUsage / zero totals / invalid JSON", async () => {
  const root = makeSessionsRoot();
  const queuePath = path.join(root, "queue.jsonl");
  const t = Date.UTC(2026, 4, 21, 14, 0, 0);

  writeSettings(root, "p", "no-usage", { model: "claude-sonnet-4-5" }, t);
  writeSettings(
    root,
    "p",
    "zero",
    {
      model: "claude-sonnet-4-5",
      tokenUsage: { inputTokens: 0, outputTokens: 0 },
    },
    t,
  );
  // Bad JSON
  const badPath = path.join(root, "p", "broken.settings.json");
  fs.writeFileSync(badPath, "{not json");

  const cursors = {};
  const res = await parseDroidIncremental({
    settingsFiles: listDroidSettingsFiles({ DROID_SESSIONS_DIR: root }),
    cursors,
    queuePath,
  });
  assert.equal(res.eventsAggregated, 0);
  assert.equal(readQueue(queuePath).filter((r) => r.source === "droid").length, 0);
});

test("parseDroidIncremental: reset (total shrinks) emits current as full delta", async () => {
  const root = makeSessionsRoot();
  const queuePath = path.join(root, "queue.jsonl");
  const t1 = Date.UTC(2026, 4, 21, 14, 0, 0);
  const filePath = writeSettings(
    root,
    "p",
    "sess-1",
    {
      model: "claude-sonnet-4-5",
      tokenUsage: { inputTokens: 5000, outputTokens: 1000 },
    },
    t1,
  );
  const cursors = {};
  await parseDroidIncremental({
    settingsFiles: [filePath],
    cursors,
    queuePath,
  });

  // Same file reused for a brand-new session — sum shrinks 6000 → 250.
  const t2 = Date.UTC(2026, 4, 21, 15, 0, 0);
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      model: "claude-sonnet-4-5",
      tokenUsage: { inputTokens: 200, outputTokens: 50 },
    }),
  );
  const t2d = new Date(t2);
  fs.utimesSync(filePath, t2d, t2d);

  await parseDroidIncremental({
    settingsFiles: [filePath],
    cursors,
    queuePath,
  });
  const rows = readQueue(queuePath).filter((r) => r.source === "droid");
  const second = rows.find((r) => r.hour_start === "2026-05-21T15:00:00.000Z");
  assert.ok(second, "expected reset row at 15:00");
  // Reset → emit current totals fully (not negative delta).
  assert.equal(second.input_tokens, 200);
  assert.equal(second.output_tokens, 50);
});

test("parseDroidIncremental: single-field shrink (e.g. cache eviction) does NOT trigger reset", async () => {
  // Regression: prior version treated ANY field dropping as a session reuse,
  // causing the historical input/output cumulative to be re-emitted whenever
  // Droid evicted cache or dropped an optional counter from its schema. New
  // contract requires the SUM to shrink before we re-emit fresh totals.
  const root = makeSessionsRoot();
  const queuePath = path.join(root, "queue.jsonl");
  const t1 = Date.UTC(2026, 4, 21, 14, 0, 0);
  const filePath = writeSettings(
    root,
    "p",
    "sess-1",
    {
      model: "claude-sonnet-4-5",
      tokenUsage: {
        inputTokens: 10000,
        outputTokens: 5000,
        cacheReadTokens: 8000,
      },
    },
    t1,
  );
  const cursors = {};
  await parseDroidIncremental({
    settingsFiles: [filePath],
    cursors,
    queuePath,
  });

  // Cache eviction: cacheRead drops 8000→0 while input/output grow by 1 each.
  // Total grows (23000 → 15002) — wait, that's a shrink. Use input/output
  // growth that keeps sumNow >= sumPrev to isolate the partial-shrink case.
  const t2 = Date.UTC(2026, 4, 21, 14, 30, 0);
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      model: "claude-sonnet-4-5",
      tokenUsage: {
        inputTokens: 18000,
        outputTokens: 5500,
        cacheReadTokens: 0,
      },
    }),
  );
  const t2d = new Date(t2);
  fs.utimesSync(filePath, t2d, t2d);

  await parseDroidIncremental({
    settingsFiles: [filePath],
    cursors,
    queuePath,
  });
  const rows = readQueue(queuePath).filter((r) => r.source === "droid");
  const second = rows.find((r) => r.hour_start === "2026-05-21T14:30:00.000Z");
  assert.ok(second, "expected delta row at 14:30");
  // Deltas only — NOT full re-emit of historical 10000/5000.
  assert.equal(second.input_tokens, 8000); // 18000 - 10000
  assert.equal(second.output_tokens, 500); // 5500 - 5000
  // cacheRead shrank → clamped to 0 (no negative deltas in queue).
  assert.equal(second.cached_input_tokens, 0);
});

test("parseDroidIncremental: transient sumNow=0 preserves prev cursor, no historical re-emit", async () => {
  // Regression: prior version overwrote prev with all zeros when settings
  // momentarily reported sumNow=0, so the next non-zero observation looked
  // like a fresh session and re-emitted the full cumulative.
  const root = makeSessionsRoot();
  const queuePath = path.join(root, "queue.jsonl");
  const t1 = Date.UTC(2026, 4, 21, 14, 0, 0);
  const filePath = writeSettings(
    root,
    "p",
    "sess-1",
    {
      model: "claude-sonnet-4-5",
      tokenUsage: { inputTokens: 1000, outputTokens: 500 },
    },
    t1,
  );
  const cursors = {};
  await parseDroidIncremental({
    settingsFiles: [filePath],
    cursors,
    queuePath,
  });

  // Transient empty (mid-write race).
  const t2 = Date.UTC(2026, 4, 21, 14, 30, 0);
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      model: "claude-sonnet-4-5",
      tokenUsage: { inputTokens: 0, outputTokens: 0 },
    }),
  );
  fs.utimesSync(filePath, new Date(t2), new Date(t2));
  await parseDroidIncremental({
    settingsFiles: [filePath],
    cursors,
    queuePath,
  });
  // Prev kept at 1000/500 despite the empty observation.
  assert.equal(cursors.droid.sessionTotals["sess-1"].input, 1000);
  assert.equal(cursors.droid.sessionTotals["sess-1"].output, 500);

  // Now Droid writes the restored payload — delta should be 100/50, NOT
  // 1100/550 (which is what we'd emit if prev had been clobbered to zero).
  const t3 = Date.UTC(2026, 4, 21, 15, 0, 0);
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      model: "claude-sonnet-4-5",
      tokenUsage: { inputTokens: 1100, outputTokens: 550 },
    }),
  );
  fs.utimesSync(filePath, new Date(t3), new Date(t3));
  await parseDroidIncremental({
    settingsFiles: [filePath],
    cursors,
    queuePath,
  });
  const rows = readQueue(queuePath).filter((r) => r.source === "droid");
  const restored = rows.find((r) => r.hour_start === "2026-05-21T15:00:00.000Z");
  assert.ok(restored, "expected delta row at 15:00 after restore");
  assert.equal(restored.input_tokens, 100);
  assert.equal(restored.output_tokens, 50);
});

test("parseDroidIncremental: empty providerLock + claude model name infers anthropic, defaults claude-unknown", async () => {
  const root = makeSessionsRoot();
  const queuePath = path.join(root, "queue.jsonl");
  const t = Date.UTC(2026, 4, 21, 14, 0, 0);
  // settings.model missing, providerLock = anthropic → ccusage parity:
  // model field becomes "claude-unknown" not just "unknown".
  const filePath = writeSettings(
    root,
    "p",
    "sess-1",
    {
      providerLock: "anthropic",
      tokenUsage: { inputTokens: 10, outputTokens: 5 },
    },
    t,
  );
  const cursors = {};
  await parseDroidIncremental({
    settingsFiles: [filePath],
    cursors,
    queuePath,
  });
  const rows = readQueue(queuePath).filter((r) => r.source === "droid");
  assert.equal(rows[0].model, "claude-unknown");
});

test("parseDroidIncremental: openai providerLock → gpt-unknown", async () => {
  const root = makeSessionsRoot();
  const queuePath = path.join(root, "queue.jsonl");
  const t = Date.UTC(2026, 4, 21, 14, 0, 0);
  const filePath = writeSettings(
    root,
    "p",
    "sess-1",
    {
      providerLock: "openai",
      tokenUsage: { inputTokens: 10, outputTokens: 5 },
    },
    t,
  );
  const cursors = {};
  await parseDroidIncremental({
    settingsFiles: [filePath],
    cursors,
    queuePath,
  });
  const rows = readQueue(queuePath).filter((r) => r.source === "droid");
  assert.equal(rows[0].model, "gpt-unknown");
});

test("parseDroidIncremental: cursor key survives parent-dir rename (filename-only key)", async () => {
  const root = makeSessionsRoot();
  const queuePath = path.join(root, "queue.jsonl");
  const t1 = Date.UTC(2026, 4, 21, 14, 0, 0);
  const t2 = Date.UTC(2026, 4, 21, 14, 30, 0);

  const original = writeSettings(
    root,
    "proj-a",
    "sess-uuid",
    {
      model: "claude-sonnet-4-5",
      tokenUsage: { inputTokens: 1000, outputTokens: 500 },
    },
    t1,
  );
  const cursors = {};
  await parseDroidIncremental({
    settingsFiles: [original],
    cursors,
    queuePath,
  });

  // Simulate FACTORY_DIR change: same session id (filename) but a different
  // parent directory.
  const movedDir = path.join(root, "proj-b");
  fs.mkdirSync(movedDir, { recursive: true });
  const moved = path.join(movedDir, "sess-uuid.settings.json");
  fs.writeFileSync(
    moved,
    JSON.stringify({
      model: "claude-sonnet-4-5",
      tokenUsage: { inputTokens: 1100, outputTokens: 550 },
    }),
  );
  fs.utimesSync(moved, new Date(t2), new Date(t2));

  await parseDroidIncremental({
    settingsFiles: [moved],
    cursors,
    queuePath,
  });
  const rows = readQueue(queuePath).filter((r) => r.source === "droid");
  const delta = rows.find((r) => r.hour_start === "2026-05-21T14:30:00.000Z");
  assert.ok(delta, "expected delta row after rename");
  // Cursor matched on filename → only the 100/50 growth is emitted, not the
  // full 1100/550 cumulative.
  assert.equal(delta.input_tokens, 100);
  assert.equal(delta.output_tokens, 50);
});

test("parseDroidIncremental: production call with explicit settingsFiles still prunes (default prune=true)", async () => {
  // Regression: an earlier version gated pruning on `!Array.isArray(settingsFiles)`,
  // which made the prune branch dead code in sync.js (which always passes an
  // explicit settingsFiles array). The fix decoupled pruning from the call
  // shape — production now gets pruning via the default `prune: true`.
  const root = makeSessionsRoot();
  const queuePath = path.join(root, "queue.jsonl");
  const t = Date.UTC(2026, 4, 21, 14, 0, 0);
  const a = writeSettings(
    root,
    "p",
    "sess-a",
    {
      model: "claude-sonnet-4-5",
      tokenUsage: { inputTokens: 100, outputTokens: 50 },
    },
    t,
  );
  const b = writeSettings(
    root,
    "p",
    "sess-b",
    {
      model: "claude-sonnet-4-5",
      tokenUsage: { inputTokens: 200, outputTokens: 80 },
    },
    t,
  );
  const cursors = {};
  // First sync: include both files (production-shape call).
  await parseDroidIncremental({
    settingsFiles: [a, b],
    cursors,
    queuePath,
  });
  assert.ok(cursors.droid.sessionTotals["sess-a"]);
  assert.ok(cursors.droid.sessionTotals["sess-b"]);

  // Delete sess-b on disk; second sync only lists `a` (mirroring how sync.js
  // calls listDroidSettingsFiles fresh each run). With prune default-true the
  // stale cursor entry for sess-b is dropped.
  fs.unlinkSync(b);
  await parseDroidIncremental({
    settingsFiles: [a],
    cursors,
    queuePath,
  });
  assert.ok(cursors.droid.sessionTotals["sess-a"]);
  assert.equal(cursors.droid.sessionTotals["sess-b"], undefined);
});

test("parseDroidIncremental: prune=false retains unseen cursor entries (test-friendly opt-out)", async () => {
  const root = makeSessionsRoot();
  const queuePath = path.join(root, "queue.jsonl");
  const t = Date.UTC(2026, 4, 21, 14, 0, 0);
  const a = writeSettings(
    root,
    "p",
    "sess-a",
    {
      model: "claude-sonnet-4-5",
      tokenUsage: { inputTokens: 100, outputTokens: 50 },
    },
    t,
  );
  const b = writeSettings(
    root,
    "p",
    "sess-b",
    {
      model: "claude-sonnet-4-5",
      tokenUsage: { inputTokens: 200, outputTokens: 80 },
    },
    t,
  );
  const cursors = {};
  await parseDroidIncremental({
    settingsFiles: [a, b],
    cursors,
    queuePath,
  });

  // Pass only `a` but opt out of pruning — sess-b cursor entry must survive.
  await parseDroidIncremental({
    settingsFiles: [a],
    cursors,
    queuePath,
    prune: false,
  });
  assert.ok(cursors.droid.sessionTotals["sess-a"]);
  assert.ok(cursors.droid.sessionTotals["sess-b"]);
});

test("parseDroidIncremental: prunes cursor entries for deleted sessions (full-scan mode)", async () => {
  const root = makeSessionsRoot();
  const queuePath = path.join(root, "queue.jsonl");
  const t = Date.UTC(2026, 4, 21, 14, 0, 0);
  const a = writeSettings(
    root,
    "p",
    "sess-a",
    {
      model: "claude-sonnet-4-5",
      tokenUsage: { inputTokens: 100, outputTokens: 50 },
    },
    t,
  );
  const b = writeSettings(
    root,
    "p",
    "sess-b",
    {
      model: "claude-sonnet-4-5",
      tokenUsage: { inputTokens: 200, outputTokens: 80 },
    },
    t,
  );
  const cursors = {};
  await parseDroidIncremental({
    cursors,
    queuePath,
    env: { DROID_SESSIONS_DIR: root },
  });
  assert.ok(cursors.droid.sessionTotals["sess-a"]);
  assert.ok(cursors.droid.sessionTotals["sess-b"]);

  // Delete sess-b from disk; a second full-scan sync should drop it from
  // the cursor so it can't resurrect as a first-sight re-emit later.
  fs.unlinkSync(b);
  await parseDroidIncremental({
    cursors,
    queuePath,
    env: { DROID_SESSIONS_DIR: root },
  });
  assert.ok(cursors.droid.sessionTotals["sess-a"]);
  assert.equal(cursors.droid.sessionTotals["sess-b"], undefined);
  // Unused var quiet
  void a;
});

test("applyDroidTotalFallback: missing output is filled from totalTokens", () => {
  // Mirrors ccusage's "applies_total_token_fallback_to_missing_output_tokens".
  const filled = applyDroidTotalFallback({
    input: 100,
    output: 0,
    cacheCreation: 0,
    cacheRead: 25,
    thinking: 0,
    totalTokens: 175,
  });
  assert.equal(filled.input, 100);
  assert.equal(filled.output, 50);
  assert.equal(filled.cacheRead, 25);
  assert.equal(filled.thinking, 0);
});

test("applyDroidTotalFallback: extra spills into thinking when output already known", () => {
  // Mirrors ccusage's "keeps_total_fallback_as_extra_when_output_is_known".
  const filled = applyDroidTotalFallback({
    input: 100,
    output: 50,
    cacheCreation: 0,
    cacheRead: 25,
    thinking: 0,
    totalTokens: 200,
  });
  assert.equal(filled.output, 50);
  assert.equal(filled.thinking, 25);
});

test("applyDroidTotalFallback: no-op when detailed fields cover the total", () => {
  const filled = applyDroidTotalFallback({
    input: 100,
    output: 50,
    cacheCreation: 0,
    cacheRead: 0,
    thinking: 0,
    totalTokens: 150,
  });
  assert.equal(filled.input, 100);
  assert.equal(filled.output, 50);
  assert.equal(filled.thinking, 0);
});

test("parseDroidIncremental: applies totalTokens fallback when output missing", async () => {
  const root = makeSessionsRoot();
  const queuePath = path.join(root, "queue.jsonl");
  const t = Date.UTC(2026, 4, 21, 14, 0, 0);
  const filePath = writeSettings(
    root,
    "p",
    "sess-1",
    {
      model: "claude-sonnet-4-5",
      tokenUsage: {
        inputTokens: 100,
        outputTokens: 0,
        cacheReadTokens: 25,
        totalTokens: 175,
      },
    },
    t,
  );
  const cursors = {};
  await parseDroidIncremental({
    settingsFiles: [filePath],
    cursors,
    queuePath,
  });
  const rows = readQueue(queuePath).filter((r) => r.source === "droid");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].input_tokens, 100);
  assert.equal(rows[0].output_tokens, 50); // 175 - 100 - 25
  assert.equal(rows[0].cached_input_tokens, 25);
});

test("extractDroidModelFromSidecarJsonl: pulls model from sibling .jsonl", () => {
  const root = makeSessionsRoot();
  const dir = path.join(root, "proj");
  fs.mkdirSync(dir, { recursive: true });
  const settingsPath = path.join(dir, "abc.settings.json");
  const sidecarPath = path.join(dir, "abc.jsonl");
  fs.writeFileSync(settingsPath, "{}");
  fs.writeFileSync(
    sidecarPath,
    [
      '{"type":"session_start","cwd":"/x"}',
      'session header — Model: claude-sonnet-4-5[Proxy]',
      '{"type":"message"}',
    ].join("\n"),
  );
  assert.equal(
    extractDroidModelFromSidecarJsonl(settingsPath),
    "claude-sonnet-4-5",
  );
});

test("extractDroidModelFromSidecarJsonl: returns empty when no Model: line", () => {
  const root = makeSessionsRoot();
  const settingsPath = path.join(root, "abc.settings.json");
  const sidecarPath = path.join(root, "abc.jsonl");
  fs.writeFileSync(settingsPath, "{}");
  fs.writeFileSync(sidecarPath, '{"type":"session_start"}\n{"type":"message"}\n');
  assert.equal(extractDroidModelFromSidecarJsonl(settingsPath), "");
});

test("parseDroidIncremental: falls back to sidecar .jsonl when settings.model missing", async () => {
  const root = makeSessionsRoot();
  const queuePath = path.join(root, "queue.jsonl");
  const t = Date.UTC(2026, 4, 21, 14, 0, 0);
  const dir = path.join(root, "proj");
  fs.mkdirSync(dir, { recursive: true });
  const settingsPath = path.join(dir, "abc.settings.json");
  const sidecarPath = path.join(dir, "abc.jsonl");
  fs.writeFileSync(
    settingsPath,
    JSON.stringify({
      tokenUsage: { inputTokens: 10, outputTokens: 5 },
    }),
  );
  fs.writeFileSync(
    sidecarPath,
    'header — Model: GLM-5.1-[Proxy]-0\nbody\n',
  );
  const td = new Date(t);
  fs.utimesSync(settingsPath, td, td);
  const cursors = {};
  await parseDroidIncremental({
    settingsFiles: [settingsPath],
    cursors,
    queuePath,
  });
  const rows = readQueue(queuePath).filter((r) => r.source === "droid");
  assert.equal(rows.length, 1);
  // ccusage cuts at the first `[`, so `GLM-5.1-[Proxy]-0` → "GLM-5.1-"
  // → normalized "glm-5-1". The `-0` after the bracket is discarded.
  assert.equal(rows[0].model, "glm-5-1");
});

test("parseDroidIncremental: empty model falls back to 'unknown'", async () => {
  const root = makeSessionsRoot();
  const queuePath = path.join(root, "queue.jsonl");
  const t = Date.UTC(2026, 4, 21, 14, 0, 0);
  const filePath = writeSettings(
    root,
    "p",
    "sess-1",
    {
      tokenUsage: { inputTokens: 10, outputTokens: 5 },
    },
    t,
  );
  const cursors = {};
  await parseDroidIncremental({
    settingsFiles: [filePath],
    cursors,
    queuePath,
  });
  const rows = readQueue(queuePath).filter((r) => r.source === "droid");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].model, "unknown");
});

// ── #204: same session id in two folders must not inflate ─────────────────────

test("dedupeDroidSettingsFilesBySession keeps the largest-cumulative canonical file", () => {
  const root = makeSessionsRoot();
  const big = writeSettings(
    root,
    ".",
    "dup",
    {
      tokenUsage: {
        inputTokens: 900000,
        outputTokens: 20000,
        cacheCreationTokens: 4000000,
        cacheReadTokens: 4000000,
        thinkingTokens: 3000,
      },
    },
    Date.UTC(2026, 4, 21, 14, 5, 0),
  );
  const small = writeSettings(
    root,
    "proj",
    "dup",
    {
      tokenUsage: {
        inputTokens: 20000,
        outputTokens: 20000,
        cacheCreationTokens: 4000000,
        cacheReadTokens: 4000000,
        thinkingTokens: 2000,
      },
    },
    Date.UTC(2026, 4, 21, 15, 10, 0),
  );
  // Larger total wins despite the smaller copy having the newer mtime.
  assert.deepEqual(dedupeDroidSettingsFilesBySession([small, big]), [big]);
});

test("dedupeDroidSettingsFilesBySession: tie on total → newest mtime wins", () => {
  const root = makeSessionsRoot();
  const usage = {
    tokenUsage: {
      inputTokens: 100,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      thinkingTokens: 0,
    },
  };
  const older = writeSettings(root, "a", "dup", usage, Date.UTC(2026, 4, 21, 14, 0, 0));
  const newer = writeSettings(root, "b", "dup", usage, Date.UTC(2026, 4, 21, 18, 0, 0));
  assert.deepEqual(dedupeDroidSettingsFilesBySession([older, newer]), [newer]);
});

test("dedupeDroidSettingsFilesBySession: totalTokens-only file beats sparse-detail file", () => {
  const root = makeSessionsRoot();
  const detail = writeSettings(
    root,
    "a",
    "dup",
    {
      tokenUsage: {
        inputTokens: 1000,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        thinkingTokens: 0,
      },
    },
    Date.UTC(2026, 4, 21, 14, 0, 0),
  );
  const totalOnly = writeSettings(
    root,
    "b",
    "dup",
    { tokenUsage: { totalTokens: 50000 } },
    Date.UTC(2026, 4, 21, 13, 0, 0), // older mtime, but the larger max(sum,total)
  );
  assert.deepEqual(dedupeDroidSettingsFilesBySession([detail, totalOnly]), [totalOnly]);
});

test("dedupeDroidSettingsFilesBySession: unique session ids pass through untouched", () => {
  const root = makeSessionsRoot();
  const a = writeSettings(root, "p", "s1", { tokenUsage: {} });
  const b = writeSettings(root, "p", "s2", { tokenUsage: {} });
  assert.equal(dedupeDroidSettingsFilesBySession([a, b]).length, 2);
});

test("parseDroidIncremental: duplicate session id across folders does NOT inflate (issue #204)", async () => {
  const root = makeSessionsRoot();
  const queuePath = path.join(root, "queue.jsonl");
  const big = {
    model: "claude-sonnet-4-5",
    tokenUsage: {
      inputTokens: 900000,
      outputTokens: 20000,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      thinkingTokens: 0,
    },
  };
  const small = {
    model: "claude-sonnet-4-5",
    tokenUsage: {
      inputTokens: 20000,
      outputTokens: 20000,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      thinkingTokens: 0,
    },
  };
  writeSettings(root, ".", "dup", big, Date.UTC(2026, 4, 21, 14, 5, 0));
  writeSettings(root, "proj", "dup", small, Date.UTC(2026, 4, 21, 15, 10, 0));

  const cursors = {};
  const env = { DROID_SESSIONS_DIR: root };
  await parseDroidIncremental({ settingsFiles: listDroidSettingsFiles(env), cursors, queuePath, env });
  // Pre-fix, this second sync re-emitted the full cumulative every run.
  const res2 = await parseDroidIncremental({
    settingsFiles: listDroidSettingsFiles(env),
    cursors,
    queuePath,
    env,
  });

  assert.equal(res2.eventsAggregated, 0, "second sync must emit nothing (no re-inflation)");
  const rows = readQueue(queuePath).filter((r) => r.source === "droid");
  assert.equal(rows.length, 1, "only the canonical file emits a single row");
  assert.equal(rows[0].total_tokens, 900000 + 20000, "counts the canonical (largest) file once");
  assert.deepEqual(Object.keys(cursors.droid.sessionTotals), ["dup"]);
});
