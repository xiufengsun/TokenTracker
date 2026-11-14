const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const serverManagerPath = path.join(
  __dirname,
  "..",
  "TokenTrackerBar",
  "TokenTrackerBar",
  "Services",
  "ServerManager.swift",
);

function readServerManager() {
  return fs.readFileSync(serverManagerPath, "utf8");
}

test("macOS app launches local CLI on the same fixed port that WKWebView loads", () => {
  const source = readServerManager();

  assert.match(
    source,
    /process\.arguments\s*=\s*\[entryPath,\s*"serve",\s*"--port",\s*"\\\(Constants\.serverPort\)",\s*"--no-sync",\s*"--no-open"\]/,
    "embedded server launch should explicitly bind Constants.serverPort",
  );
  assert.match(
    source,
    /serve --port \\\(Constants\.serverPort\) --no-sync --no-open/,
    "system CLI fallback should bind the dashboard port without opening a browser",
  );
});
