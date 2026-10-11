const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { PNG } = require("pngjs");

const repoRoot = path.resolve(__dirname, "..");
const linuxDir = path.join(repoRoot, "TokenTrackerLinux");
const bundleScript = path.join(linuxDir, "scripts", "bundle-node-linux.sh");
const canonicalIcon = path.join(repoRoot, "dashboard", "public", "icon-512.png");
const unixBundleFixture = {
  skip: process.platform === "win32" && "Linux bundle fixtures require POSIX Bash, executable scripts and symlinks; Linux and macOS CI run them",
};

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function writeExecutable(file, contents) {
  fs.writeFileSync(file, contents, { mode: 0o755 });
}

// realpath: macOS os.tmpdir() sits under the /var symlink, which the bundle script's guard refuses.
function makeTempDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

test("Linux bundle rebuilds an isolated runtime and synchronizes an isolated Tauri icon", unixBundleFixture, () => {
  const tempDir = makeTempDir("tokentracker-linux-bundle-");
  const toolsDir = path.join(tempDir, "tools");
  const embeddedServer = path.join(tempDir, "EmbeddedServer");
  const dashboardDist = path.join(tempDir, "dashboard-dist");
  const tauriIcon = path.join(tempDir, "icon.png");
  const staleFile = path.join(embeddedServer, "stale.txt");

  try {
    fs.mkdirSync(toolsDir, { recursive: true });
    fs.mkdirSync(embeddedServer, { recursive: true });
    fs.writeFileSync(staleFile, "stale runtime artifact");
    fs.mkdirSync(dashboardDist, { recursive: true });
    fs.writeFileSync(path.join(dashboardDist, "index.html"), "<main>dashboard fixture</main>");

    // The bundle script verifies the downloaded Node tarball with `sha256sum`,
    // and so does the stubbed curl below. That binary is GNU coreutils and does
    // not exist on macOS, so stubbing curl/tar/npm but not the checksum tool is
    // what kept this test Linux-only. The shim is a real SHA-256 in sha256sum's
    // output format, so the checksum gate is still exercised, not bypassed.
    fs.writeFileSync(path.join(toolsDir, "sha256sum.cjs"), `const { createHash } = require("node:crypto");
const fs = require("node:fs");
const digest = (buffer) => createHash("sha256").update(buffer).digest("hex");
const files = process.argv.slice(2);
const targets = files.length > 0 ? files : ["-"];
for (const target of targets) {
  process.stdout.write(\`\${digest(fs.readFileSync(target === "-" ? 0 : target))}  \${target}\\n\`);
}
`);
    writeExecutable(path.join(toolsDir, "sha256sum"), `#!/usr/bin/env bash
set -euo pipefail
exec "\${TOKENTRACKER_TEST_NODE:-node}" "$(dirname "$0")/sha256sum.cjs" "$@"
`);
    writeExecutable(path.join(toolsDir, "curl"), `#!/usr/bin/env bash
set -euo pipefail
output=""
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "-o" ]]; then output="$2"; shift 2; else shift; fi
done
if [[ "$output" == *SHASUMS256.txt ]]; then
  printf '%s  node-v22.22.2-linux-x64.tar.gz\n' "$(printf fake-node-tarball | sha256sum | awk '{print $1}')" > "$output"
else
  printf fake-node-tarball > "$output"
fi
`);
    writeExecutable(path.join(toolsDir, "tar"), `#!/usr/bin/env bash
set -euo pipefail
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "-C" ]]; then destination="$2"; shift 2; else shift; fi
done
mkdir -p "$destination/node-v22.22.2-linux-x64/bin"
printf '#!/usr/bin/env bash\nprintf 22.22.2\n' > "$destination/node-v22.22.2-linux-x64/bin/node"
chmod +x "$destination/node-v22.22.2-linux-x64/bin/node"
`);
    writeExecutable(path.join(toolsDir, "npm"), "#!/usr/bin/env bash\nexit 0\n");

    const bundleResult = spawnSync("bash", [bundleScript], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${toolsDir}:${process.env.PATH}`,
        TOKENTRACKER_TEST_NODE: process.execPath,
        TOKENTRACKER_LINUX_EMBED_DIR: embeddedServer,
        TOKENTRACKER_DASHBOARD_DIST: dashboardDist,
        TOKENTRACKER_TAURI_ICON: tauriIcon,
      },
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    assert.equal(
      bundleResult.status,
      0,
      `bundle script failed: ${bundleResult.error?.message || bundleResult.stderr}`
    );

    assert.equal(fs.existsSync(staleFile), false, "rebuild must remove stale output files");
    for (const requiredFile of [
      "node",
      "tokentracker/bin/tracker.js",
      "tokentracker/package.json",
      "tokentracker/dashboard/dist/index.html",
    ]) {
      assert.equal(fs.existsSync(path.join(embeddedServer, requiredFile)), true, `missing ${requiredFile}`);
    }
    const canonicalPixels = PNG.sync.read(fs.readFileSync(canonicalIcon));
    const tauriPixels = PNG.sync.read(fs.readFileSync(tauriIcon));
    assert.equal(tauriPixels.colorType, 6, "Tauri icon must be encoded as RGBA");
    assert.equal(tauriPixels.width, canonicalPixels.width);
    assert.equal(tauriPixels.height, canonicalPixels.height);
    assert.equal(
      sha256(tauriPixels.data),
      sha256(canonicalPixels.data),
      "controlled bundle must preserve the canonical icon pixels"
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Linux bundle refuses to clean an unsafe output path", unixBundleFixture, () => {
  const tempDir = makeTempDir("tokentracker-linux-clean-");
  const unsafeOutput = path.join(tempDir, "important-output");
  const sentinel = path.join(unsafeOutput, "keep.txt");

  try {
    fs.mkdirSync(unsafeOutput, { recursive: true });
    fs.writeFileSync(sentinel, "keep me");

    const result = spawnSync("bash", [bundleScript, "--clean"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        TOKENTRACKER_LINUX_EMBED_DIR: unsafeOutput,
      },
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /path not named EmbeddedServer/);
    assert.equal(fs.readFileSync(sentinel, "utf8"), "keep me");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Linux bundle refuses to clean through a symlinked parent directory", unixBundleFixture, () => {
  const tempDir = makeTempDir("tokentracker-linux-symlink-");
  const realParent = path.join(tempDir, "real-parent");
  const linkedParent = path.join(tempDir, "linked-parent");
  const embeddedServer = path.join(realParent, "EmbeddedServer");
  const sentinel = path.join(embeddedServer, "keep.txt");

  try {
    fs.mkdirSync(embeddedServer, { recursive: true });
    fs.writeFileSync(sentinel, "keep me");
    fs.symlinkSync(realParent, linkedParent, "dir");

    const result = spawnSync("bash", [bundleScript, "--clean"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        TOKENTRACKER_LINUX_EMBED_DIR: path.join(linkedParent, "EmbeddedServer"),
      },
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /path containing a symlink/);
    assert.equal(fs.readFileSync(sentinel, "utf8"), "keep me");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Linux bundle rejects unsupported architecture overrides before downloading", unixBundleFixture, () => {
  const result = spawnSync("bash", [bundleScript, "--clean"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      TARGET_ARCH: "../../unexpected",
    },
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unsupported Linux architecture/);
});
