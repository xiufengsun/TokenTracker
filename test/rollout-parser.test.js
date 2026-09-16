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
    resolveWorkbuddyHome({ HOME: tmpHome, WORKBUDDY_HOME: "/cn" }),
    "/cn",
  );
  assert.equal(
    resolveWorkbuddyHome({ HOME: tmpHome, WORKBUDDY_AI_HOME: "/intl" }, "workbuddy-ai"),
    "/intl",
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

test("teardown: remove the temporary HOME", () => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  assert.ok(true);
});
