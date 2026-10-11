/**
 * Companion test for the WorkBuddy AI (international build) variant.
 *
 * Asserts the two variants resolve to sibling homes and that the parser keeps
 * independent cursor namespaces so the builds never share dedup state.
 *
 * Uses a real temporary HOME (so the win32 existence-checked path resolution
 * can return the directory); no real ~/.workbuddy or ~/.workbuddy-ai is touched.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { detectPassiveProviders } = require("../src/lib/passive-mode");
const { getModelPricing } = require("../src/lib/pricing");

const {
  resolveWorkbuddyHome,
  resolveWorkbuddyProjectFiles,
  parseWorkbuddyIncremental,
  WORKBUDDY_VARIANTS,
} = require("../src/lib/rollout");

// A real temporary HOME that contains both variant homes, so the win32
// existence-checked resolver returns the directory (it returns null otherwise).
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "wbh-"));
fs.mkdirSync(path.join(tmpHome, ".workbuddy"));
fs.mkdirSync(path.join(tmpHome, ".workbuddy-ai"));
const env = { HOME: tmpHome };

test("resolveWorkbuddyHome: CN variant defaults to ~/.workbuddy", () => {
  assert.equal(
    resolveWorkbuddyHome(env),
    path.join(tmpHome, ".workbuddy"),
  );
});

test("resolveWorkbuddyHome: international variant defaults to ~/.workbuddy-ai", () => {
  assert.equal(
    resolveWorkbuddyHome(env, "workbuddy-ai"),
    path.join(tmpHome, ".workbuddy-ai"),
  );
});

test("resolveWorkbuddyHome: per-variant env overrides", () => {
  assert.equal(
    resolveWorkbuddyHome({ HOME: tmpHome, WORKBUDDY_HOME: path.join(tmpHome, "cn") }),
    path.join(tmpHome, "cn"),
  );
  assert.equal(
    resolveWorkbuddyHome({ HOME: tmpHome, WORKBUDDY_AI_HOME: path.join(tmpHome, "intl") }, "workbuddy-ai"),
    path.join(tmpHome, "intl"),
  );
  // The CN override must not leak into the international variant.
  assert.equal(
    resolveWorkbuddyHome({ HOME: tmpHome, WORKBUDDY_HOME: "/cn" }, "workbuddy-ai"),
    path.join(tmpHome, ".workbuddy-ai"),
  );
});

test("resolveWorkbuddyHome: unknown variant falls back to CN", () => {
  assert.equal(
    resolveWorkbuddyHome(env, "nope"),
    path.join(tmpHome, ".workbuddy"),
  );
});

test("WorkBuddy AI normalizes home overrides and passive detection consistently", () => {
  for (const value of ["~/profiles/intl", "profiles/intl", "  ~/profiles/intl  "]) {
    const customEnv = { HOME: tmpHome, WORKBUDDY_AI_HOME: value };
    const expected = path.join(tmpHome, "profiles", "intl");
    assert.equal(resolveWorkbuddyHome(customEnv, "workbuddy-ai"), expected);
    fs.mkdirSync(path.join(expected, "projects"), { recursive: true });
    fs.writeFileSync(path.join(expected, "settings.json"), "{}");
    const provider = detectPassiveProviders({ home: tmpHome, env: customEnv, hookStatus: {} })
      .find((item) => item.name === "workbuddy-ai");
    assert.equal(provider.logs_present, true);
    assert.equal(provider.passive, true);
  }
});

test("WorkBuddy AI preserves official model prices without guessing auto routing", () => {
  assert.equal(getModelPricing("gpt-6-astra", { source: "workbuddy-ai" }).input, 10);
  assert.equal(getModelPricing("gpt-6-astra", { source: "workbuddy-ai" }).output, 50);
  assert.equal(getModelPricing("auto", { source: "workbuddy-ai" }).input, 0);
  assert.ok(getModelPricing("auto", { source: "cursor" }).input > 0);
});

test("WORKBUDDY_VARIANTS exposes both builds and their env vars", () => {
  assert.deepEqual(Object.keys(WORKBUDDY_VARIANTS).sort(), [
    "workbuddy",
    "workbuddy-ai",
  ]);
  assert.equal(WORKBUDDY_VARIANTS.workbuddy.dir, ".workbuddy");
  assert.equal(WORKBUDDY_VARIANTS["workbuddy-ai"].dir, ".workbuddy-ai");
  assert.equal(WORKBUDDY_VARIANTS.workbuddy.envVar, "WORKBUDDY_HOME");
  assert.equal(WORKBUDDY_VARIANTS["workbuddy-ai"].envVar, "WORKBUDDY_AI_HOME");
});

test("resolveWorkbuddyProjectFiles: returns [] when the variant home is absent", () => {
  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), "wbh-empty-"));
  const emptyEnv = { HOME: emptyHome };
  assert.deepEqual(resolveWorkbuddyProjectFiles(emptyEnv), []);
  assert.deepEqual(resolveWorkbuddyProjectFiles(emptyEnv, "workbuddy-ai"), []);
  fs.rmSync(emptyHome, { recursive: true, force: true });
});

/**
 * Cursor-namespace isolation. The parser must key its state off `source`, so
 * the CN and international builds never share `seenIds` / `fileOffsets`.
 */
test("parseWorkbuddyIncremental: variants use separate cursor namespaces", async () => {
  const cursors = {};
  const queuePath = path.join(os.tmpdir(), `wb-${Date.now()}.jsonl`);

  const shared = {
    cursors,
    queuePath,
    projectFiles: [],
    env,
  };

  await parseWorkbuddyIncremental({ ...shared, source: "workbuddy" });
  await parseWorkbuddyIncremental({ ...shared, source: "workbuddy-ai" });

  assert.ok(cursors.workbuddy, "expected a `workbuddy` cursor namespace");
  assert.ok(cursors["workbuddy-ai"], "expected a `workbuddy-ai` cursor namespace");
  assert.notEqual(cursors.workbuddy, cursors["workbuddy-ai"]);
});

test("WorkBuddy builds count identical response IDs separately and replay neither", async () => {
  const queuePath = path.join(tmpHome, "variant-queue.jsonl");
  const cursors = {};
  const line = JSON.stringify({
    id: "response-shared", type: "function_call", sessionId: "session-shared",
    timestamp: Date.UTC(2026, 9, 7, 1),
    providerData: { model: "gpt-6-astra", messageId: "message-shared",
      rawUsage: { prompt_tokens: 100, completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 30 },
        completion_tokens_details: { reasoning_tokens: 5 } } },
  });
  for (const source of ["workbuddy", "workbuddy-ai"]) {
    const projectDir = path.join(resolveWorkbuddyHome(env, source), "projects", "project");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, "session.jsonl"), line + "\n");
    const first = await parseWorkbuddyIncremental({ cursors, queuePath, env, source });
    assert.equal(first.eventsAggregated, 1);
  }
  const before = fs.readFileSync(queuePath, "utf8");
  const rows = before.trim().split("\n").map(JSON.parse);
  assert.deepEqual(rows.map((row) => row.source).sort(), ["workbuddy", "workbuddy-ai"]);
  for (const row of rows) {
    assert.equal(row.input_tokens, 70);
    assert.equal(row.cached_input_tokens, 30);
    assert.equal(row.output_tokens, 15);
    assert.equal(row.reasoning_output_tokens, 5);
    assert.equal(row.total_tokens, 120);
  }
  for (const source of ["workbuddy", "workbuddy-ai"]) {
    const repeated = await parseWorkbuddyIncremental({ cursors, queuePath, env, source });
    assert.equal(repeated.eventsAggregated, 0);
  }
  assert.equal(fs.readFileSync(queuePath, "utf8"), before);
});

test("teardown: remove the temporary HOME", () => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  assert.ok(true);
});
