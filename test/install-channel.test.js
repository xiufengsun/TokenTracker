"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  detectInstallChannel,
  PACKAGE_NAME,
  BREW_FORMULA,
} = require("../src/lib/install-channel");

function detect(entryPath) {
  return detectInstallChannel({
    entryPath,
    realpathSync: (p) => p,
  });
}

test("detects brew keg even when the formula vendor copy lives in node_modules", () => {
  const channel = detect(
    "/opt/homebrew/Cellar/tokentracker/0.96.2/libexec/lib/node_modules/tokentracker-cli/bin/tracker.js",
  );
  assert.equal(channel.method, "brew");
  assert.equal(channel.command, `brew upgrade ${BREW_FORMULA}`);
});

test("detects brew opt prefix", () => {
  const channel = detect("/opt/homebrew/opt/tokentracker/libexec/bin/tracker.js");
  assert.equal(channel.method, "brew");
});

test("does not treat Homebrew's npm global prefix as a brew formula", () => {
  const channel = detect("/opt/homebrew/lib/node_modules/tokentracker-cli/bin/tracker.js");
  assert.equal(channel.method, "npm");
  assert.equal(channel.command, `npm install -g ${PACKAGE_NAME}@latest`);
});

test("detects a user-local npm prefix as npm, not a source tree", () => {
  const channel = detect("/home/u/.local/lib/node_modules/tokentracker-cli/bin/tracker.js");
  assert.equal(channel.method, "npm");
  assert.equal(channel.action.bin, "npm");
});

test("detects linuxbrew Cellar installs as brew", () => {
  const channel = detect(
    "/home/linuxbrew/.linuxbrew/Cellar/tokentracker/0.96.2/libexec/lib/node_modules/tokentracker-cli/bin/tracker.js",
  );
  assert.equal(channel.method, "brew");
});

test("detects npm, bun, pnpm, yarn, and npx from their install layouts", () => {
  assert.equal(
    detect("/home/u/.nvm/versions/node/v20.11.0/lib/node_modules/tokentracker-cli/bin/tracker.js").method,
    "npm",
  );
  assert.equal(
    detect("/home/u/.bun/install/global/node_modules/tokentracker-cli/bin/tracker.js").method,
    "bun",
  );
  assert.equal(
    detect(
      "/home/u/.local/share/pnpm/global/5/node_modules/.pnpm/tokentracker-cli@0.96.2/node_modules/tokentracker-cli/bin/tracker.js",
    ).method,
    "pnpm",
  );
  assert.equal(
    detect("/home/u/.config/yarn/global/node_modules/tokentracker-cli/bin/tracker.js").method,
    "yarn",
  );
  const npx = detect("/home/u/.npm/_npx/123abc/node_modules/tokentracker-cli/bin/tracker.js");
  assert.equal(npx.method, "npx");
  assert.equal(npx.action, null);
  assert.match(npx.reason, /npx tokentracker-cli@latest/);
});

test("detects desktop EmbeddedServer bundles on POSIX and Windows paths", () => {
  const mac = detect(
    "/Applications/TokenTracker.app/Contents/Resources/EmbeddedServer/tokentracker/bin/tracker.js",
  );
  assert.equal(mac.method, "desktop");
  assert.equal(mac.action, null);
  assert.match(mac.reason, /desktop app/);

  const win = detect(
    "C:\\Program Files\\TokenTracker\\EmbeddedServer\\tokentracker\\bin\\tracker.js",
  );
  assert.equal(win.method, "desktop");
});

test("refuses unmanaged source checkouts and mentions git pull when .git exists", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tt-install-"));
  try {
    fs.mkdirSync(path.join(root, "src"));
    fs.mkdirSync(path.join(root, "bin"));
    fs.mkdirSync(path.join(root, ".git"));
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: PACKAGE_NAME, version: "0.0.0" }),
    );
    fs.writeFileSync(path.join(root, "src", "cli.js"), "module.exports = {};\n");
    const entry = path.join(root, "bin", "tracker.js");
    fs.writeFileSync(entry, "");
    const channel = detect(entry);
    assert.equal(channel.method, "other");
    assert.equal(channel.action, null);
    assert.equal(channel.sourceRoot, root);
    assert.equal(channel.git, true);
    assert.match(channel.reason, /git checkout/);
    assert.match(channel.reason, /git -C /);
    assert.ok(channel.reason.includes(root));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detects the repository checkout from bin/tracker.js", () => {
  const channel = detectInstallChannel({
    entryPath: path.join(__dirname, "..", "bin", "tracker.js"),
  });
  assert.equal(channel.method, "other");
  assert.equal(channel.git, true);
  assert.match(channel.reason, /git checkout/);
});
