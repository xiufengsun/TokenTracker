const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");
const { backendFromUrl, captureClaudeBackend, readCustomBackend } = require("../src/lib/claude-backend");
const { parseClaudeIncremental } = require("../src/lib/rollout");
const { computeRowCost, getModelPricingInfo } = require("../src/lib/pricing");
const { scanClaudeSession } = require("../src/lib/session-analytics");
const { buildNotifyHandler } = require("../src/commands/init");
const { getUsageLimits, resetUsageLimitsCache } = require("../src/lib/usage-limits");

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "claude-backend-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const trackerDir = path.join(home, ".tokentracker", "tracker");
  fs.mkdirSync(trackerDir, { recursive: true });
  const file = path.join(home, "session.jsonl");
  fs.writeFileSync(file, "");
  const queuePath = path.join(trackerDir, "queue.jsonl");
  const cursors = {};
  let seq = 0;
  const append = (obj) => fs.appendFileSync(file, JSON.stringify({ sessionId: "s1", cwd: home, timestamp: "2026-11-01T12:01:00Z", ...obj }) + "\r\n");
  return { home, trackerDir, file, queuePath, cursors,
    hook(event, url) { captureClaudeBackend(trackerDir, { hook_event_name: event, session_id: "s1", transcript_path: file }, { ANTHROPIC_BASE_URL: url }); },
    turn() {
      seq++;
      append({ type: "user", uuid: `u${seq}`, message: { content: "多字节" } });
      append({ type: "assistant", uuid: `a${seq}`, message: { id: `m${seq}`, model: "claude-sonnet-4-6", usage: { input_tokens: 100, output_tokens: 10 } } });
    },
    async sync() {
      await parseClaudeIncremental({ projectFiles: [file], queuePath, cursors });
      Object.assign(cursors, JSON.parse(JSON.stringify(cursors)));
    },
    rows() { return fs.readFileSync(queuePath, "utf8").trim().split("\n").map(JSON.parse); },
  };
}
const A = "https://api.anthropic.com";
const B = "https://user:password@gateway.example:8443/secret-path?key=secret-query#secret-fragment";
const originB = "https://gateway.example:8443";

test("endpoint sanitizer accepts HTTP(S) origins only and never reads credentials", () => {
  assert.deepEqual(backendFromUrl(B), { backend: "custom", backend_origin: originB });
  assert.equal(backendFromUrl(A + "/v1").backend, "anthropic");
  for (const value of [undefined, "", "bad-url", "file:///secret", "https://api.anthropic.com.evil/"]) {
    assert.notEqual(backendFromUrl(value).backend, "anthropic");
  }
  assert.equal(backendFromUrl("http://localhost:8082/v1").backend_origin, "http://localhost:8082");
});

test("stable brackets, endpoint changes, and incremental sync preserve logical usage and provenance", async (t) => {
  const f = fixture(t);
  f.hook("SessionStart", A);
  f.turn(); f.hook("Stop", A); await f.sync();
  const original = f.rows()[0];
  f.turn(); f.hook("Stop", B); await f.sync(); // disagree -> unknown
  f.turn(); f.hook("Stop", B); await f.sync(); // custom
  f.turn(); f.hook("Stop", A); await f.sync(); // disagree -> unknown
  const row = f.rows().at(-1);
  assert.equal(row.model, "claude-sonnet-4-6");
  assert.equal(row.total_tokens, 440);
  assert.equal(row.conversation_count, 4);
  assert.deepEqual(row.backend_usage.map((p) => [p.backend, p.total_tokens]), [["anthropic", 110], ["unknown", 220], ["custom", 110]]);
  assert.equal(row.backend_usage[2].backend_origin, originB);
  assert.equal(computeRowCost(row), computeRowCost(original));
  assert.equal(getModelPricingInfo(row.model, row).status, "unpriced");
  const saved = fs.readFileSync(f.queuePath, "utf8");
  await f.sync();
  assert.equal(fs.readFileSync(f.queuePath, "utf8"), saved);
  assert.deepEqual(f.rows()[0], original);
  const session = await scanClaudeSession(f.file, { trackerDir: f.trackerDir });
  assert.equal(session.model, row.model);
  assert.equal(session.total_tokens, row.total_tokens);
  assert.equal(session.cost_usd, computeRowCost(row));
  assert.equal(session.cost_is_partial, true);
  assert.deepEqual(session.model_usage[0].backend_usage, row.backend_usage);
  for (const name of fs.readdirSync(path.join(f.trackerDir, "claude-backends"))) {
    const data = fs.readFileSync(path.join(f.trackerDir, "claude-backends", name), "utf8");
    for (const secret of ["password", "secret-path", "secret-query", "secret-fragment", "多字节"]) assert.ok(!data.includes(secret));
  }
});

for (const scenario of ["changed-first-turn", "missing-start", "missing-stop", "missing-env", "malformed", "legacy", "missed-middle-stop", "session-end-only"]) {
  test(`ambiguous context stays unknown: ${scenario}`, async (t) => {
    const f = fixture(t);
    const value = scenario === "missing-env" ? undefined : scenario === "malformed" ? "invalid" : B;
    if (!["missing-start", "legacy", "session-end-only"].includes(scenario)) f.hook("SessionStart", value);
    f.turn();
    if (scenario === "missed-middle-stop") f.turn();
    if (!["missing-stop", "legacy", "session-end-only"].includes(scenario)) f.hook("Stop", scenario === "changed-first-turn" ? A : value);
    if (scenario === "session-end-only") f.hook("SessionEnd", B);
    await f.sync();
    const row = f.rows().at(-1);
    assert.equal(row.backend_usage[0].backend, "unknown");
    assert.equal(row.backend_usage[0].backend_origin, undefined);
    assert.equal(computeRowCost(row), 0); // priced subtotal; explicitly unpriced, NOT free
    assert.equal(getModelPricingInfo(row.model, row).status, "unpriced");
  });
}

test("late Stop, current environment and resumed sessions never relabel earlier ingestion", async (t) => {
  const f = fixture(t);
  f.hook("SessionStart", B); f.turn(); await f.sync();
  const saved = fs.readFileSync(f.queuePath, "utf8");
  f.hook("Stop", B);
  await f.sync();
  assert.equal(fs.readFileSync(f.queuePath, "utf8"), saved);
  f.hook("SessionStart", A); f.turn(); f.hook("Stop", A); await f.sync();
  assert.deepEqual(f.rows().at(-1).backend_usage.map((p) => p.backend), ["unknown", "anthropic"]);
  const session = await scanClaudeSession(f.file, { trackerDir: f.trackerDir });
  assert.deepEqual(session.model_usage[0].backend_usage.map((p) => p.backend), ["unknown", "anthropic"]);
});

test("generated notify captures before throttle and stores only sanitized identity", (t) => {
  const f = fixture(t);
  const notify = path.join(f.home, "notify.cjs");
  fs.writeFileSync(notify, buildNotifyHandler({ trackerDir: f.trackerDir }));
  fs.writeFileSync(path.join(f.trackerDir, "sync.throttle"), String(Date.now() + 3600000));
  const result = cp.spawnSync(process.execPath, [notify, "--source=claude"], {
    input: JSON.stringify({ hook_event_name: "SessionStart", session_id: "s1", transcript_path: f.file, prompt: "not-for-storage" }),
    env: { ...process.env, ANTHROPIC_BASE_URL: B, ANTHROPIC_AUTH_TOKEN: "never-read-me" }, timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr.toString());
  assert.deepEqual(readCustomBackend({ home: f.home, env: {} }), { backend: "custom", backend_origin: originB });
});

test("limits expose a custom backend without OAuth and do not request Anthropic quotas", async (t) => {
  const f = fixture(t);
  f.hook("SessionStart", B);
  resetUsageLimitsCache();
  t.after(resetUsageLimitsCache);
  const result = await getUsageLimits({ home: f.home, platform: "linux", providerTimeoutMs: 50,
    securityRunner: () => ({ status: 1, stdout: "" }), commandRunner: () => ({ status: 1, stdout: "" }),
    fetchImpl: async (url) => { assert.ok(!String(url).includes("api.anthropic.com")); throw new Error("offline"); },
  });
  assert.equal(result.claude.configured, true);
  assert.equal(result.claude.limits_status, "not_applicable");
  assert.equal(result.claude.cost_status, "unknown");
  assert.equal(result.claude.five_hour, undefined);
});

test("current config only affects limits; a pre-existing queue snapshot stays byte-identical", async (t) => {
  const f = fixture(t);
  f.turn(); await f.sync();
  // Simulate a previously ingested bucket, which had no provenance contract.
  const rows = f.rows().map(({ backend_usage, ...row }) => row);
  fs.writeFileSync(f.queuePath, rows.map(JSON.stringify).join("\n") + "\n");
  for (const bucket of Object.values(f.cursors.hourly.buckets)) delete bucket.totals.backend_usage;
  const oldBytes = fs.readFileSync(f.queuePath, "utf8");
  const oldCost = computeRowCost(rows.at(-1));
  fs.mkdirSync(path.join(f.home, ".claude"));
  fs.writeFileSync(path.join(f.home, ".claude", "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: B } }));
  assert.equal(readCustomBackend({ home: f.home, env: {} }).backend, "custom");
  await f.sync();
  assert.equal(fs.readFileSync(f.queuePath, "utf8"), oldBytes);
  f.hook("SessionStart", B); f.turn(); f.hook("Stop", B); await f.sync();
  assert.ok(fs.readFileSync(f.queuePath, "utf8").startsWith(oldBytes));
  const newRow = f.rows().at(-1);
  assert.equal(newRow.backend_usage[0].total_tokens, 110);
  assert.equal(newRow.total_tokens, 220);
  assert.equal(computeRowCost(newRow), oldCost);
});

test("SessionStart joins existing usage hooks and uninstall preserves foreign commands", async (t) => {
  const f = fixture(t);
  const { upsertClaudeUsageHooks, removeClaudeUsageHooks, areClaudeUsageHooksConfigured } = require("../src/lib/claude-config");
  const settingsPath = path.join(f.home, "settings.json");
  const hookCommand = `node ${path.join(f.home, ".tokentracker/bin/notify.cjs")} --source=claude`;
  fs.writeFileSync(settingsPath, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo foreign" }] }] } }));
  await upsertClaudeUsageHooks({ settingsPath, hookCommand });
  assert.equal(await areClaudeUsageHooksConfigured({ settingsPath, hookCommand }), true);
  const installed = JSON.parse(fs.readFileSync(settingsPath));
  for (const event of ["SessionStart", "Stop", "SessionEnd"]) {
    assert.ok(JSON.stringify(installed.hooks[event]).includes("notify.cjs"));
  }
  await removeClaudeUsageHooks({ settingsPath, hookCommand });
  const removed = fs.readFileSync(settingsPath, "utf8");
  assert.ok(removed.includes("echo foreign"));
  assert.ok(!removed.includes("notify.cjs"));
});

test("concurrent resolvers agree on the first persisted decision even after a late hook", (t) => {
  const f = fixture(t);
  const { createBackendResolver } = require("../src/lib/claude-backend");
  f.hook("SessionStart", B); f.turn();
  const early = createBackendResolver(f.file, f.trackerDir);
  f.hook("Stop", B);
  const late = createBackendResolver(f.file, f.trackerDir);
  const raw = fs.readFileSync(f.file);
  const start = raw.indexOf(10) + 1;
  const obj = JSON.parse(raw.subarray(start).toString("utf8"));
  assert.equal(early(obj, start, raw.length).backend, "unknown");
  assert.equal(late(obj, start, raw.length).backend, "unknown");
});

test("project queue persists the same sanitized backend subsets as hourly usage", async (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.home, ".git"));
  fs.writeFileSync(path.join(f.home, ".git", "config"), '[remote "origin"]\nurl = https://github.com/example/project.git\n');
  f.hook("SessionStart", B); f.turn(); f.hook("Stop", B);
  const projectQueuePath = path.join(f.trackerDir, "project.queue.jsonl");
  const options = { projectFiles: [f.file], cursors: f.cursors, queuePath: f.queuePath, projectQueuePath,
    publicRepoResolver: async ({ projectRef }) => ({ status: "public_verified", projectKey: "example/project", projectRef }) };
  await parseClaudeIncremental(options);
  const saved = fs.readFileSync(projectQueuePath, "utf8");
  const project = JSON.parse(saved.trim());
  assert.equal(project.total_tokens, 110);
  assert.deepEqual(project.backend_usage, f.rows().at(-1).backend_usage);
  await parseClaudeIncremental(options);
  assert.equal(fs.readFileSync(projectQueuePath, "utf8"), saved);
});

test("rewritten transcripts cannot inherit a stale observation range", async (t) => {
  const f = fixture(t);
  f.hook("SessionStart", B); f.turn(); f.hook("Stop", B);
  // Same inode and same byte length, different usage identity: old hooks are
  // not evidence for a new transcript occupying the same pathname.
  fs.writeFileSync(f.file, fs.readFileSync(f.file, "utf8").replace('"m1"', '"m2"'));
  await f.sync();
  assert.equal(f.rows().at(-1).backend_usage[0].backend, "unknown");
});
