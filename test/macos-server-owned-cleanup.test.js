const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

test("macOS embedded startup leaves an unrelated listener alive", { skip: process.platform !== "darwin", timeout: 120_000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-owned-cleanup-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // The listener belongs only to this fixture and uses a random free port.
  // Never run startup against either real desktop app's port or personal data.
  const listener = spawn(process.execPath, ["-e", `
    require('node:net').createServer().listen(0, '127.0.0.1', function () {
      process.stdout.write(String(this.address().port) + '\\n');
    });
  `], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => listener.kill("SIGKILL"));
  const port = await new Promise((resolve, reject) => {
    let stderr = "";
    listener.stderr.on("data", data => { stderr += data; });
    const timer = setTimeout(() => reject(new Error("fixture listener did not start")), 10_000);
    listener.once("error", error => { clearTimeout(timer); reject(error); });
    listener.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`fixture listener exited (${code ?? signal}): ${stderr}`));
    });
    listener.stdout.once("data", data => { clearTimeout(timer); resolve(Number(String(data).trim())); });
  });
  assert.ok(port > 0);

  const contents = path.join(root, "Cleanup Probe.app/Contents");
  const binary = path.join(contents, "MacOS/CleanupProbe");
  const resources = path.join(contents, "Resources/EmbeddedServer");
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.mkdirSync(path.join(resources, "tokentracker/bin"), { recursive: true });
  fs.writeFileSync(path.join(contents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
    <plist version="1.0"><dict>
    <key>CFBundleIdentifier</key><string>com.tokentracker.tests.cleanup-probe</string>
    <key>CFBundleExecutable</key><string>CleanupProbe</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    </dict></plist>`);
  // A harmless child stands in for the CLI. Its own process exits immediately;
  // the real CLI's identity-filtered port handling has separate integration tests.
  const embeddedNode = path.join(resources, "node");
  fs.copyFileSync(process.execPath, embeddedNode);
  fs.writeFileSync(path.join(resources, "tokentracker/bin/tracker.js"), "");
  const verifierDirectory = path.join(resources, "tokentracker/src/commands");
  fs.mkdirSync(verifierDirectory, { recursive: true });
  // Exercise the actual shared CLI identity implementation as well as the
  // production Swift call site; this shim only binds its fixture module path.
  fs.writeFileSync(path.join(verifierDirectory, "serve.js"),
    `module.exports = require(${JSON.stringify(path.join(__dirname, "../src/commands/serve.js"))});`);
  const harness = path.join(root, "Probe.swift");
  fs.writeFileSync(harness, `
    import Foundation
    enum Constants { static let serverPort = Int(ProcessInfo.processInfo.environment["FIXTURE_PORT"]!)! }
    enum NativeQAProfile { static let isQABuild = false }
    enum ServerHealthCheckPolicy {
      enum Ownership { case ownedProcess, externalProcess }
      static func interval(for ownership: Ownership) -> TimeInterval { 300 }
    }
    enum Strings {
      static let serverNotAvailableMessage = "unavailable"
      static let serverExitedUnexpectedly = "exited"
      static let serverBecameUnreachable = "unreachable"
      static func serverNotResponding(port: Int) -> String { "not responding" }
      static func embeddedServerLaunchFailed(_ message: String) -> String { message }
      static func serverLaunchFailed(_ message: String) -> String { message }
    }
    @MainActor final class APIClient {
      static let shared = APIClient()
      func checkServerHealth() async -> Bool { true }
    }
    @main struct Probe {
      @MainActor static func main() async {
        let manager = ServerManager()
        await manager.ensureServerRunning()
        manager.stopServer()
        print("probe completed")
      }
    }
  `);
  const compiled = spawnSync("/usr/bin/xcrun", [
    "swiftc", "-parse-as-library", "-module-cache-path", path.join(root, "modules"),
    path.join(__dirname, "../TokenTrackerBar/TokenTrackerBar/Services/ServerManager.swift"),
    harness, "-o", binary,
  ], { encoding: "utf8", timeout: 90_000 });
  assert.equal(compiled.status, 0, compiled.stderr);
  const result = spawnSync(binary, [], { env: { ...process.env, FIXTURE_PORT: String(port) }, encoding: "utf8", timeout: 20_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /probe completed/);
  // Give Node's child-exit notification a turn after the synchronous probe.
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(listener.exitCode, null, "the unrelated listener must stay alive");
  assert.equal(listener.signalCode, null, "startup must not signal an unowned listener");

  for (const [packageName, verifierFails] of [["tokentracker-cli", false], ["unrelated-package", false], ["tokentracker-cli", true]]) {
    if (verifierFails) {
      // Even plausible stdout must not authorize a signal after a failed verifier.
      fs.writeFileSync(path.join(verifierDirectory, "serve.js"), "process.stdout.write('verified'); process.exit(1);");
    }
    const packageRoot = path.join(root, "packages with spaces", packageName);
    const entry = path.join(packageRoot, "bin/tracker.js");
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: packageName }));
    fs.writeFileSync(entry, "require('node:net').createServer().listen(0, '127.0.0.1', function () { process.stdout.write(String(this.address().port)); });");
    const candidate = spawn(embeddedNode, [entry, "serve", "--port", "0"], { stdio: ["ignore", "pipe", "pipe"] });
    t.after(() => candidate.kill("SIGKILL"));
    const candidatePort = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("candidate did not start")), 10_000);
      candidate.once("error", error => { clearTimeout(timer); reject(error); });
      candidate.once("exit", code => { clearTimeout(timer); reject(new Error(`candidate exited: ${code}`)); });
      candidate.stdout.once("data", data => { clearTimeout(timer); resolve(Number(String(data).trim())); });
    });
    const command = spawnSync("/bin/ps", ["-ww", "-p", String(candidate.pid), "-o", "command="], { encoding: "utf8", timeout: 5000 });
    assert.equal(command.status, 0, command.stderr);
    assert.ok(command.stdout.trim().startsWith(embeddedNode + " "), "candidate must actually run through the spaced embedded Node path");
    const probe = spawnSync(binary, [], {
      env: { ...process.env, FIXTURE_PORT: String(candidatePort) }, encoding: "utf8", timeout: 20_000,
    });
    assert.equal(probe.status, 0, probe.stderr);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(candidate.signalCode, packageName === "tokentracker-cli" && !verifierFails ? "SIGTERM" : null,
      "only a successful identity check can authorize replacing a listener");
  }
});
