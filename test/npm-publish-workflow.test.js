const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { assertReleaseVersion } = require("../scripts/version-files.cjs");

const WORKFLOW_PATH = path.join(
  __dirname,
  "..",
  ".github",
  "workflows",
  "npm-publish.yml"
);
const CI_WORKFLOW_PATH = path.join(__dirname, "..", ".github", "workflows", "ci.yml");

function loadWorkflow() {
  return fs.readFileSync(WORKFLOW_PATH, "utf8");
}

test("npm-publish workflow file exists", () => {
  assert.ok(fs.existsSync(WORKFLOW_PATH), "workflow file should exist");
});

test("workflow triggers only after canonical CI completes on main", () => {
  const content = loadWorkflow();
  assert.ok(content.includes("workflow_run:"), "should trigger from workflow_run");
  assert.ok(content.includes("workflows: [CI]"), "should depend on canonical CI");
  assert.ok(content.includes("types: [completed]"), "should wait for CI completion");
  assert.ok(
    content.includes("branches: [main]"),
    "should target main branch only"
  );
});

test("canonical CI never cancels an in-flight main version commit", () => {
  const content = fs.readFileSync(CI_WORKFLOW_PATH, "utf8");
  assert.ok(
    content.includes("cancel-in-progress: ${{ github.event_name == 'pull_request' }}"),
    "main CI runs must survive later pushes so npm remains pinned to the version commit",
  );
});

test("publish job builds/publishes on Node.js 20 to match the engines floor", () => {
  const content = loadWorkflow();
  const publishIdx = content.indexOf("\n  publish:");
  assert.ok(publishIdx > 0, "should have a publish job");
  const publishSection = content.slice(publishIdx);
  assert.ok(
    publishSection.includes("node-version: 20"),
    "publish job should build/publish on Node 20 (engines: >=20)"
  );
});

test("successful push CI gates publish and the exact tested SHA is checked out", () => {
  const content = loadWorkflow();
  assert.ok(content.includes("workflow_run.conclusion == 'success'"));
  assert.ok(content.includes("workflow_run.event == 'push'"));
  assert.ok(content.includes("workflow_run.head_branch == 'main'"));
  assert.ok(
    content.includes("ref: ${{ github.event.workflow_run.head_sha || github.sha }}"),
    "publish must build the exact commit that passed CI"
  );
  assert.ok(content.includes("fetch-depth: 2"), "publish must inspect the tested commit's parent");
  assert.ok(!content.includes("\n  test:"), "must not maintain a weaker duplicate test job");
});

// The automatic gate keys on "this commit changed the version", so a version
// whose own CI failed can never publish afterwards: the fix-up commit passes CI
// but leaves the version unchanged. workflow_dispatch is the recovery path, and
// it must not become a way to publish untested code.
test("the manual publish path still requires green CI and an unpublished version", () => {
  const content = loadWorkflow();
  assert.ok(content.includes("workflow_dispatch:"), "a recovery path must exist");
  assert.ok(
    content.includes("github.event_name == 'workflow_dispatch' ||"),
    "dispatch must be allowed alongside the workflow_run gate, not replace it",
  );
  assert.ok(
    content.includes("gh run list --workflow CI --branch main --commit"),
    "dispatch must verify this exact commit's CI rather than trusting the operator",
  );
  assert.ok(
    content.includes('if [ "$CI_CONCLUSION" != "success" ]'),
    "anything other than a successful CI conclusion must refuse to publish",
  );
  assert.ok(
    content.includes("Refusing to publish."),
    "the refusal must be explicit rather than a silent skip",
  );
  // The already-on-npm guard is shared by both paths; dispatch must not bypass it.
  assert.ok(
    content.includes("steps.version-check.outputs.exists == 'false'"),
    "dispatch must still be blocked by an already-published version",
  );
});

test("workflow sets npm registry URL", () => {
  const content = loadWorkflow();
  assert.ok(
    content.includes("registry-url: https://registry.npmjs.org"),
    "should configure npm registry"
  );
});

test("workflow checks version before publishing", () => {
  const content = loadWorkflow();
  assert.ok(
    content.includes("npm view tokentracker-cli"),
    "should check if version already exists on npm"
  );
  assert.ok(
    content.includes("git show HEAD^:package.json"),
    "only the tested commit that changed package.json may publish"
  );
  assert.ok(
    content.includes("outputs.eligible == 'true'"),
    "publish steps must require an exact version-changing commit"
  );
  assert.ok(content.includes("set -euo pipefail"), "provenance checks must fail closed");
  assert.ok(
    !content.includes("JSON.parse(s).version||'')}catch{}})\" || true"),
    "parent version lookup must not swallow checkout or JSON errors",
  );
  assert.ok(
    content.includes('r?.error?.code') && content.includes('= "E404"'),
    "only a confirmed npm E404 may be treated as unpublished",
  );
  assert.ok(
    content.includes("npm registry lookup failed without a confirmed E404"),
    "other registry failures must stop publication",
  );
  assert.ok(
    content.includes("assertReleaseVersion(process.argv[1],'package.json version')") &&
      content.includes("assertReleaseVersion(process.argv[1],'parent package.json version')"),
    "current and parent package versions must be validated before npm lookup",
  );
});

test("workflow skip notices are reason-specific and avoid expression injection", () => {
  const content = loadWorkflow();
  assert.ok(content.includes("Skip unchanged-version commit"));
  assert.ok(content.includes("Skip already-published version"));
  assert.ok(content.includes("PACKAGE_VERSION: ${{ steps.version-check.outputs.version }}"));
  assert.ok(
    !content.includes('run: echo "v${{ steps.version-check.outputs.version }}'),
    "step outputs must not be interpolated directly into shell source",
  );
});

test("publish version validation rejects malformed current and parent versions", () => {
  assert.equal(assertReleaseVersion("0.88.3", "current"), "0.88.3");
  for (const invalid of ["", "v0.88.3", "0.88", "0.88.3-beta.1", "01.2.3"]) {
    assert.throws(() => assertReleaseVersion(invalid, "current"), /stable x\.y\.z/);
    assert.throws(() => assertReleaseVersion(invalid, "parent"), /stable x\.y\.z/);
  }
});

test("workflow builds dashboard before publish", () => {
  const content = loadWorkflow();
  const buildIndex = content.indexOf("dashboard:build");
  const publishIndex = content.indexOf("run: npm publish");
  assert.ok(buildIndex > 0, "should build dashboard");
  assert.ok(publishIndex > 0, "should run npm publish");
  assert.ok(
    buildIndex < publishIndex,
    "dashboard build must come before npm publish"
  );
});

test("workflow uses NPM_TOKEN secret", () => {
  const content = loadWorkflow();
  assert.ok(
    content.includes("secrets.NPM_TOKEN"),
    "should reference NPM_TOKEN secret for authentication"
  );
});

test("workflow skips all steps when version already published", () => {
  const content = loadWorkflow();
  const conditionalSteps = (content.match(/if:.*version-check.*false/g) || [])
    .length;
  // install root, install dashboard, build, publish = 4 conditional steps
  assert.ok(
    conditionalSteps >= 4,
    `should have at least 4 steps gated on version check, found ${conditionalSteps}`
  );
});

test("workflow has concurrency guard to prevent parallel publishes", () => {
  const content = loadWorkflow();
  assert.ok(
    content.includes("concurrency:"),
    "should have concurrency config"
  );
  assert.ok(
    content.includes("cancel-in-progress: false"),
    "should not cancel in-progress publish"
  );
});

test("workflow installs dashboard dependencies separately", () => {
  const content = loadWorkflow();
  assert.ok(
    content.includes("npm ci --prefix dashboard"),
    "should install dashboard deps with --prefix"
  );
});

test("package.json files array includes dashboard/dist", () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")
  );
  assert.ok(
    pkg.files.includes("dashboard/dist/"),
    "published package must include dashboard/dist/"
  );
});
