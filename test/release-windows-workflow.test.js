const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const WORKFLOW_PATH = path.join(
  __dirname,
  "..",
  ".github",
  "workflows",
  "release-windows.yml"
);

function loadWorkflow() {
  return fs.readFileSync(WORKFLOW_PATH, "utf8");
}

test("Windows release includes and verifies the resident quota entry", () => {
  assert.match(loadWorkflow(), /TOKENTRACKER_BUILD_PET:\s*"1"/);
  assert.ok(loadWorkflow().includes("dashboard/dist/quota.html"));
  const config = fs.readFileSync(path.join(__dirname, "..", "dashboard", "vite.config.js"), "utf8");
  assert.match(config, /rollupInput\.quota\s*=\s*path\.resolve\(ROOT_DIR, "quota.html"\)/);
});

test("release-windows workflow file exists", () => {
  assert.ok(fs.existsSync(WORKFLOW_PATH));
});

test("workflow triggers on workflow_dispatch with version input", () => {
  const content = loadWorkflow();
  assert.ok(content.includes("workflow_dispatch:"));
  assert.ok(content.includes("version:"));
});

test("workflow uses Windows runner", () => {
  const content = loadWorkflow();
  assert.ok(
    /runs-on:\s*windows-/.test(content),
    "should use a Windows runner for dotnet publish + bundle-node.ps1"
  );
});

test("workflow sets up .NET 8 SDK", () => {
  const content = loadWorkflow();
  assert.ok(content.includes("setup-dotnet"));
  assert.ok(/dotnet-version:\s*8\./.test(content));
});

test("workflow verifies version matches package.json and csproj", () => {
  const content = loadWorkflow();
  assert.ok(content.includes("Verify version"), "should have a version step");
  assert.ok(content.includes("package.json"), "should check package.json");
  assert.ok(
    content.includes("TokenTrackerWin.csproj"),
    "should check the csproj <Version>"
  );
});

test("workflow builds dashboard before bundling EmbeddedServer", () => {
  const content = loadWorkflow();
  const dashBuild = content.indexOf("dashboard:build");
  const bundle = content.indexOf("bundle-node.ps1");
  assert.ok(dashBuild > 0, "should build dashboard");
  assert.ok(bundle > 0, "should bundle EmbeddedServer");
  assert.ok(
    dashBuild < bundle,
    "dashboard build must come before EmbeddedServer bundle"
  );
});

test("workflow bundles EmbeddedServer via bundle-node.ps1", () => {
  const content = loadWorkflow();
  assert.ok(content.includes("bundle-node.ps1"));
});

test("workflow publishes a self-contained win-x64 build", () => {
  const content = loadWorkflow();
  assert.ok(content.includes("dotnet publish"));
  assert.ok(content.includes("-r win-x64"));
  assert.ok(
    content.includes("--self-contained true"),
    "must be self-contained so users need no separate .NET runtime install"
  );
});

test("workflow stages EmbeddedServer next to the exe", () => {
  const content = loadWorkflow();
  assert.ok(
    /Copy-Item\s+TokenTrackerWin\/EmbeddedServer/.test(content),
    "dotnet publish does not include EmbeddedServer; it must be copied next to the exe"
  );
});

test("workflow verifies the packaged runtime is complete", () => {
  const content = loadWorkflow();
  assert.ok(content.includes("EmbeddedServer/node.exe"));
  assert.ok(content.includes("EmbeddedServer/tokentracker/bin/tracker.js"));
});

test("workflow packages a zip release asset", () => {
  const content = loadWorkflow();
  assert.ok(content.includes("Compress-Archive"));
  assert.ok(content.includes("TokenTracker-win-x64"));
});

test("workflow builds the installer with Inno Setup", () => {
  const content = loadWorkflow();
  assert.ok(content.includes("ISCC"), "should invoke Inno Setup's ISCC compiler");
  assert.ok(
    content.includes("TokenTrackerWin/installer/TokenTracker.iss") ||
      content.includes("TokenTrackerWin\\installer\\TokenTracker.iss"),
    "should compile the .iss script"
  );
});

test("workflow attaches the zip and the installer to a GitHub release", () => {
  const content = loadWorkflow();
  assert.ok(content.includes("gh release"));
  assert.ok(content.includes("TokenTracker-win-x64"), "zip asset");
  assert.ok(content.includes("TokenTracker-Setup"), "installer asset");
});

test("Windows builds from the version tag and only uploads to a draft", () => {
  const content = loadWorkflow();
  assert.ok(
    content.includes("ref: refs/tags/v${{ inputs.version }}"),
    "Windows must build from the immutable version tag"
  );
  assert.ok(content.includes("--json isDraft"), "must inspect release draft state");
  assert.ok(
    content.includes("Published assets are immutable"),
    "must reject public same-version releases"
  );
  assert.ok(
    !/^\s*gh release create\b/m.test(content),
    "standalone Windows workflow must never create a public release"
  );
});

test("workflow uploads version-less assets only (no versioned duplicate)", () => {
  const content = loadWorkflow();
  // The gh release upload/create lines must reference the stable $zip / $setup
  // vars, not the versioned build artifacts ($zipBuilt / $setupBuilt), so the
  // release page shows a single copy of each Windows asset — mirroring the
  // version-less macOS DMG instead of doubling up versioned + stable names.
  const ghLines = content
    .split("\n")
    .filter((l) => /gh release (upload|create)/.test(l));
  assert.ok(ghLines.length >= 1, "should have a gh release upload/create line");
  for (const line of ghLines) {
    assert.ok(
      !/Built/.test(line),
      `must not upload versioned build artifact: ${line.trim()}`
    );
    assert.ok(
      /\$zip\b/.test(line) && /\$setup\b/.test(line),
      `must upload the stable $zip + $setup aliases: ${line.trim()}`
    );
  }
});

test("workflow uploads a stable version-less installer alias for landing deep links", () => {
  const content = loadWorkflow();
  // The landing page links releases/latest/download/TokenTracker-Setup.exe,
  // which only resolves if a version-less asset of that exact name is uploaded.
  assert.ok(
    /TokenTracker-Setup\.exe/.test(content),
    "must upload a version-less TokenTracker-Setup.exe alias"
  );
});

test("workflow has correct step order: dashboard → bundle → publish → copy → zip → installer → release", () => {
  const content = loadWorkflow();
  const steps = [
    "dashboard:build",
    "bundle-node.ps1",
    "dotnet publish",
    "Copy-Item TokenTrackerWin/EmbeddedServer",
    "Compress-Archive",
    "ISCC",
    "gh release",
  ];
  let lastIndex = -1;
  for (const step of steps) {
    const idx = content.indexOf(step);
    assert.ok(idx > lastIndex, `"${step}" should come after the previous step`);
    lastIndex = idx;
  }
});

test("workflow has concurrency guard", () => {
  const content = loadWorkflow();
  assert.ok(content.includes("concurrency:"));
});

test("workflow has write permissions for release creation", () => {
  const content = loadWorkflow();
  assert.ok(content.includes("contents: write"));
});

const ISS_PATH = path.join(
  __dirname,
  "..",
  "TokenTrackerWin",
  "installer",
  "TokenTracker.iss"
);

function loadIss() {
  return fs.readFileSync(ISS_PATH, "utf8");
}

test("Inno Setup script exists", () => {
  assert.ok(fs.existsSync(ISS_PATH));
});

test("installer is per-user (no admin / UAC)", () => {
  const iss = loadIss();
  assert.ok(
    /PrivilegesRequired\s*=\s*lowest/.test(iss),
    "must install per-user so it never elevates"
  );
  assert.ok(
    iss.includes("{localappdata}"),
    "should install under %LOCALAPPDATA%"
  );
});

test("installer bundles the self-contained publish output", () => {
  const iss = loadIss();
  assert.ok(
    /Source:\s*"\.\.\\publish\\\*"/.test(iss),
    "should pack ..\\publish\\* (exe + runtime + EmbeddedServer)"
  );
});

test("installer output is parameterized by version", () => {
  const iss = loadIss();
  assert.ok(iss.includes("MyAppVersion"), "version must be passed in via /D");
  assert.ok(
    iss.includes("TokenTracker-Setup-v"),
    "output filename should carry the version"
  );
});

test("installer offers English + Simplified + Traditional Chinese", () => {
  const iss = loadIss();
  assert.ok(/MessagesFile:\s*"compiler:Default\.isl"/.test(iss), "English");
  assert.ok(iss.includes("ChineseSimplified.isl"), "Simplified Chinese");
  assert.ok(iss.includes("ChineseTraditional.isl"), "Traditional Chinese");
});

test("bundled Chinese language files exist as UTF-8 with BOM", () => {
  const installerDir = path.join(__dirname, "..", "TokenTrackerWin", "installer");
  for (const name of ["ChineseSimplified.isl", "ChineseTraditional.isl"]) {
    const p = path.join(installerDir, name);
    assert.ok(fs.existsSync(p), `${name} must be committed (Inno does not ship it)`);
    const buf = fs.readFileSync(p);
    assert.ok(
      buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf,
      `${name} must start with a UTF-8 BOM so Inno renders Chinese, not mojibake`
    );
  }
});

// ── Linked release: one DMG dispatch ships BOTH platforms ──────────────────
// release-windows is a reusable workflow (workflow_call) that the macOS DMG
// workflow invokes, so `gh workflow run "release DMG"` fans out to Windows too.

const DMG_WORKFLOW_PATH = path.join(
  __dirname,
  "..",
  ".github",
  "workflows",
  "release-dmg.yml"
);

test("release-windows is callable as a reusable workflow", () => {
  const content = loadWorkflow();
  assert.ok(
    content.includes("workflow_call:"),
    "must expose workflow_call so the DMG workflow can invoke it"
  );
});

test("release-dmg invokes release-windows so one dispatch ships both platforms", () => {
  const dmg = fs.readFileSync(DMG_WORKFLOW_PATH, "utf8");
  assert.ok(
    /uses:\s*\.\/\.github\/workflows\/release-windows\.yml/.test(dmg),
    "DMG workflow must call the Windows reusable workflow"
  );
  assert.ok(
    /version:\s*\$\{\{\s*inputs\.version\s*\}\}/.test(dmg),
    "DMG workflow must pass its version input through to Windows"
  );
});

test("macOS + Windows build in parallel off a shared create-release job", () => {
  const dmg = fs.readFileSync(DMG_WORKFLOW_PATH, "utf8");
  // A dedicated create-release job makes the release first; both the macOS
  // `build` job and the `windows` job depend on it (NOT on each other), so they
  // run in parallel and each uploads its assets with --clobber.
  assert.ok(/^\s{2}create-release:/m.test(dmg), "must have a create-release job");
  assert.ok(
    /windows:\s*\n\s*needs:\s*create-release/.test(dmg),
    "windows job must declare `needs: create-release` (parallel, not serial)"
  );
  assert.ok(
    /build:\s*\n\s*needs:\s*create-release/.test(dmg),
    "macOS build job must also depend on create-release"
  );
});
