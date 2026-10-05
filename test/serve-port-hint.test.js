const assert = require("node:assert/strict");
const cp = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const CURRENT_PACKAGE_VERSION = require("../package.json").version;

const {
  buildPortInUseHint,
  isPortUnavailableError,
  ensurePortFree,
  isTokenTrackerServeCommand,
  listenOnAvailablePort,
  NPM_PACKAGE_NAME,
  parseServeScriptPath,
  parseArgs,
  isRunningUnderWsl,
  resolveDefaultPort,
} = require("../src/commands/serve");

function mockPlatform(t, platform) {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform });
  t.after(() => Object.defineProperty(process, "platform", original));
}

test("serve port collision hint references the published npm package name", () => {
  assert.equal(NPM_PACKAGE_NAME, "tokentracker-cli");
  assert.equal(
    buildPortInUseHint(7681),
    "Port 7681 is still in use after cleanup. Try: npx tokentracker-cli serve --port 7682\n",
  );
});

test("serve treats Windows EACCES bind failures as port unavailable", () => {
  assert.equal(isPortUnavailableError({ code: "EACCES" }), true);
  assert.equal(isPortUnavailableError({ code: "EADDRINUSE" }), true);
  assert.equal(isPortUnavailableError({ code: "EINVAL" }), false);
});

test("serve default startup falls through to the next available port", async (t) => {
  let occupied = null;
  let occupiedPort = null;
  for (let attempt = 0; attempt < 20; attempt++) {
    occupied = http.createServer((_req, res) => res.end("occupied"));
    await new Promise((resolve) => occupied.listen(0, "127.0.0.1", resolve));
    occupiedPort = occupied.address().port;
    if (occupiedPort < 65535 && await canBind(occupiedPort + 1)) {
      break;
    }
    await closeServer(occupied);
    occupied = null;
    occupiedPort = null;
  }
  assert.ok(occupied, "expected to find a free adjacent fallback port");
  t.after(() => closeServer(occupied));

  const server = http.createServer((_req, res) => res.end("fallback"));
  t.after(() => closeServer(server));

  const selectedPort = await listenOnAvailablePort(server, occupiedPort, {
    allowFallback: true,
    maxAttempts: 3,
  });

  assert.equal(selectedPort, occupiedPort + 1);
});

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error && error.code !== "ERR_SERVER_NOT_RUNNING") reject(error);
      else resolve();
    });
  });
}

async function canBind(port) {
  const server = http.createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
    return true;
  } catch {
    return false;
  } finally {
    await closeServer(server).catch(() => {});
  }
}

async function getFreePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await closeServer(server);
  return port;
}

test("serve respects explicit port from --port and PORT env", (t) => {
  mockPlatform(t, "darwin");
  assert.deepEqual(parseArgs([], { PORT: "7700" }), {
    port: 7700,
    portExplicit: true,
    wslDefaultPort: false,
    open: true,
    sync: true,
  });
  assert.deepEqual(parseArgs(["--port", "7701", "--no-open", "--no-sync"], { PORT: "7700" }), {
    port: 7701,
    portExplicit: true,
    wslDefaultPort: false,
    open: false,
    sync: false,
  });
  assert.deepEqual(parseArgs([], {}), {
    port: 7680,
    portExplicit: false,
    wslDefaultPort: false,
    open: true,
    sync: true,
  });
});

// #267: Windows Delivery Optimization (DoSvc) holds 0.0.0.0:7680 on the host,
// so under WSL the default port must move off 7680. Explicit --port / PORT
// always win.
test("serve default port moves to 7681 under WSL", (t) => {
  mockPlatform(t, "linux");
  const wslEnv = { WSL_DISTRO_NAME: "Ubuntu" };

  assert.equal(resolveDefaultPort(wslEnv), 7681);

  const opts = parseArgs([], wslEnv);
  assert.equal(opts.port, 7681);
  assert.equal(opts.portExplicit, false);
  assert.equal(opts.wslDefaultPort, true, "flags the WSL port shift for the startup notice");

  const explicit = parseArgs(["--port", "7680"], wslEnv);
  assert.equal(explicit.port, 7680, "--port 7680 is respected even under WSL");
  assert.equal(explicit.wslDefaultPort, false);

  const envPort = parseArgs([], { ...wslEnv, PORT: "7690" });
  assert.equal(envPort.port, 7690, "PORT env is respected even under WSL");
  assert.equal(envPort.wslDefaultPort, false);
});

test("isRunningUnderWsl detection matrix", (t) => {
  mockPlatform(t, "linux");
  assert.equal(isRunningUnderWsl({ WSL_DISTRO_NAME: "Ubuntu" }), true, "WSL_DISTRO_NAME env");
  assert.equal(isRunningUnderWsl({ WSL_INTEROP: "/run/WSL/1_interop" }), true, "WSL_INTEROP env");
  assert.equal(
    isRunningUnderWsl({}, () => "Linux version 5.15.167.4-microsoft-standard-WSL2"),
    true,
    "/proc/version fingerprint",
  );
  assert.equal(
    isRunningUnderWsl({}, () => "Linux version 6.1.0-generic (gcc ...)"),
    false,
    "plain Linux stays on the standard default",
  );
  assert.equal(
    isRunningUnderWsl({}, () => { throw new Error("EACCES"); }),
    false,
    "unreadable /proc/version fails safe",
  );
  assert.equal(resolveDefaultPort({}, () => "Linux version 6.1.0-generic"), 7680);
});

test("isRunningUnderWsl is false off Linux regardless of env", (t) => {
  mockPlatform(t, "darwin");
  assert.equal(isRunningUnderWsl({ WSL_DISTRO_NAME: "Ubuntu" }), false);
  assert.equal(resolveDefaultPort({ WSL_DISTRO_NAME: "Ubuntu" }), 7680);
});

test("serve-command parsing survives ps output quirks", () => {
  // `ps -o command=` joins argv with spaces and drops all quoting, so the
  // script path is only unambiguous relative to the `serve` argument after it.
  assert.equal(
    parseServeScriptPath("node /home/u/Token Tracker/bin/tracker.js serve"),
    "/home/u/Token Tracker/bin/tracker.js",
  );
  assert.equal(
    parseServeScriptPath("/opt/app/node /opt/app/tokentracker/bin/tracker.js serve --no-open"),
    "/opt/app/tokentracker/bin/tracker.js",
  );

  // `serve` can occur inside the install path as well as being the subcommand,
  // so the delimiter is chosen by which prefix is actually a tracker entry.
  // Taking the first boundary would parse this as "/home/u/my".
  assert.equal(
    parseServeScriptPath("node /home/u/my serve dir/bin/tracker.js serve --port 7680"),
    "/home/u/my serve dir/bin/tracker.js",
  );
  // ...and equally, a later `serve` among the arguments must not win.
  assert.equal(
    parseServeScriptPath("node /opt/tt/bin/tracker.js serve --dir /my serve/x"),
    "/opt/tt/bin/tracker.js",
  );

  // Not a node `serve` invocation at all.
  assert.equal(parseServeScriptPath("python3 /usr/lib/tokentracker/bin/tracker.js serve"), null);
  assert.equal(parseServeScriptPath("node /usr/lib/tokentracker/bin/tracker.js sync"), null);
  assert.equal(parseServeScriptPath("/usr/bin/postgres -D /var/lib/pgsql serve"), null);
  assert.equal(parseServeScriptPath("nginx: worker process"), null);
  // ps prints nothing once the pid is gone; never treat that as a match.
  assert.equal(parseServeScriptPath(""), null);
});

test("port cleanup only targets a real TokenTracker package", (t) => {
  // Path shape alone is not identifying: unrelated projects ship a
  // `bin/tracker.js` too, so the entry must resolve into a genuine
  // tokentracker-cli package before anything is signalled.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tt-serve-id-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const install = (name, pkgName) => {
    const dir = path.join(root, name);
    fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
    fs.writeFileSync(path.join(dir, "bin", "tracker.js"), "");
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: pkgName }));
    return path.join(dir, "bin", "tracker.js");
  };

  const ours = install("ours", NPM_PACKAGE_NAME);
  assert.equal(isTokenTrackerServeCommand(`node ${ours} serve --port 7680`), true);

  // Same layout, different package: someone else's tracker.
  const theirs = install("theirs", "some-other-tracker");
  assert.equal(isTokenTrackerServeCommand(`node ${theirs} serve`), false);

  // The npm bin shim is a symlink into the package; realpath must be followed.
  const shimDir = path.join(root, "node_modules", ".bin");
  fs.mkdirSync(shimDir, { recursive: true });
  const shim = path.join(shimDir, "tokentracker-cli");
  fs.symlinkSync(ours, shim);
  assert.equal(isTokenTrackerServeCommand(`node ${shim} serve`), true);

  // The same, end to end: a genuine package under a directory containing
  // " serve " must still be recognised, or its cleanup silently stops working.
  const oddDir = path.join(root, "my serve dir");
  fs.mkdirSync(path.join(oddDir, "bin"), { recursive: true });
  fs.writeFileSync(path.join(oddDir, "bin", "tracker.js"), "");
  fs.writeFileSync(path.join(oddDir, "package.json"), JSON.stringify({ name: NPM_PACKAGE_NAME }));
  assert.equal(
    isTokenTrackerServeCommand(`node ${path.join(oddDir, "bin", "tracker.js")} serve --port 7680`),
    true,
  );

  // A lookalike path that does not exist resolves to nothing, so it is never
  // signalled -- the case that made a bare path-shape check unsafe.
  assert.equal(isTokenTrackerServeCommand("node /srv/other/bin/tracker.js serve"), false);
  // tracker.js outside a bin/ directory is rejected before any filesystem work.
  assert.equal(isTokenTrackerServeCommand("node /srv/other/tracker.js serve"), false);
});

test("port scan is limited to listeners, not everything touching the port", () => {
  // `lsof -i tcp:<port>` matches a socket whose LOCAL *or REMOTE* port matches,
  // so without -sTCP:LISTEN a browser connected to the dashboard is reported
  // alongside the server it is talking to.
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "commands", "serve.js"), "utf8");
  assert.match(source, /"-sTCP:LISTEN"/);
});

function hasLsof() {
  try {
    cp.execFileSync("lsof", ["-v"], { stdio: "ignore", timeout: 5000 });
    return true;
  } catch (_e) {
    return false;
  }
}

function createHealthyServeFixture(root, serverVersion = CURRENT_PACKAGE_VERSION) {
  const binDir = path.join(root, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: NPM_PACKAGE_NAME }),
  );
  const entry = path.join(binDir, "tracker.js");
  fs.writeFileSync(
    entry,
    [
      'const http = require("node:http");',
      'const args = process.argv.slice(2);',
      'const portIndex = args.indexOf("--port");',
      'const port = portIndex >= 0 ? Number(args[portIndex + 1]) : 0;',
      'const server = http.createServer((req, res) => {',
      '  if (req.url === "/api/local-auth") {',
      '    res.writeHead(200, { "Content-Type": "application/json" });',
      `    res.end(JSON.stringify({ token: "fixture", serverVersion: ${JSON.stringify(serverVersion)} }));`,
      '    return;',
      '  }',
      '  res.writeHead(404);',
      '  res.end();',
      '});',
      'server.listen(port, "127.0.0.1", () => {',
      '  process.stdout.write(String(server.address().port) + "\\n");',
      '});',
    ].join("\n"),
  );
  return entry;
}

async function spawnHealthyServeFixture(entry, port = 0) {
  const child = cp.spawn(
    process.execPath,
    [entry, "serve", "--port", String(port)],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  const reportedPort = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("fixture server never reported a port")), 10000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.stdout.once("data", (chunk) => {
      clearTimeout(timer);
      resolve(Number(String(chunk).trim()));
    });
  });
  return { child, port: reportedPort };
}

async function waitForChildExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("fixture server did not exit")), 10000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function waitForLocalAuth(port, expectedVersion) {
  const deadline = Date.now() + 15000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const payload = await new Promise((resolve, reject) => {
        const req = http.get(
          `http://127.0.0.1:${port}/api/local-auth`,
          { timeout: 1000 },
          (res) => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (chunk) => { body += chunk; });
            res.on("end", () => {
              try {
                resolve({ statusCode: res.statusCode, body: JSON.parse(body) });
              } catch (error) {
                reject(error);
              }
            });
          },
        );
        req.on("error", reject);
        req.on("timeout", () => req.destroy(new Error("health check timeout")));
      });
      if (payload.statusCode === 200 && payload.body?.serverVersion === expectedVersion) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`real serve process never became healthy: ${lastError?.message || "timeout"}`);
}

function collectChildOutput(child) {
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  return {
    get stdout() { return stdout; },
    get stderr() { return stderr; },
  };
}

test("real serve entry exits duplicate cleanly without replacing the first process", async (t) => {
  if (!hasLsof()) return t.skip("requires lsof");

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-real-serve-duplicate-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const trackerDir = path.join(home, ".tokentracker", "tracker");
  fs.mkdirSync(trackerDir, { recursive: true });
  fs.writeFileSync(path.join(trackerDir, "cursors.json"), "{}\n");

  const port = await getFreePort();
  const entry = path.join(__dirname, "..", "bin", "tracker.js");
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    TOKENTRACKER_SKIP_LOCAL_RUNTIME_COPY: "1",
  };
  const args = [entry, "serve", "--port", String(port), "--no-sync", "--no-open"];

  const first = cp.spawn(process.execPath, args, {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const firstOutput = collectChildOutput(first);
  t.after(() => {
    if (first.exitCode === null && first.signalCode === null) first.kill("SIGKILL");
  });

  await waitForLocalAuth(port, CURRENT_PACKAGE_VERSION);
  assert.equal(first.exitCode, null, `first serve exited early: ${firstOutput.stderr}`);

  const second = cp.spawn(process.execPath, args, {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const secondOutput = collectChildOutput(second);
  await waitForChildExit(second);

  assert.equal(second.exitCode, 0, `duplicate serve failed: ${secondOutput.stderr}`);
  assert.match(
    secondOutput.stdout,
    new RegExp(`already active and healthy on port ${port}\\. Exiting duplicate server smoothly\\.`),
  );
  assert.equal(first.exitCode, null, "the first real serve process must remain alive");
  assert.equal(first.signalCode, null, "the first real serve process must not be signalled");
  assert.equal(await canBind(port), false, "the first real serve process should still own the port");
});

test("ensurePortFree reuses a healthy server from the same installation", async (t) => {
  if (!hasLsof()) return t.skip("requires lsof");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tt-serve-same-install-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const entry = createHealthyServeFixture(root);
  const { child, port } = await spawnHealthyServeFixture(entry);
  t.after(() => child.kill("SIGKILL"));

  let requestedExit = null;
  await ensurePortFree(port, {
    currentPackageRoot: root,
    exitFn: (code) => { requestedExit = code; },
  });

  assert.equal(requestedExit, 0, "a same-install healthy duplicate should exit successfully");
  assert.equal(child.exitCode, null, "the existing same-install server must remain alive");
  assert.equal(child.signalCode, null, "the existing same-install server must not be signalled");
  assert.equal(await canBind(port), false, "the original server should still own the port");
});

test("ensurePortFree replaces a healthy server from a stale installation", async (t) => {
  if (!hasLsof()) return t.skip("requires lsof");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tt-serve-stale-install-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const oldRoot = path.join(root, "old");
  const newRoot = path.join(root, "new");
  const oldEntry = createHealthyServeFixture(oldRoot);
  const newEntry = createHealthyServeFixture(newRoot);

  const oldServer = await spawnHealthyServeFixture(oldEntry);
  t.after(() => oldServer.child.kill("SIGKILL"));

  let requestedExit = false;
  await ensurePortFree(oldServer.port, {
    currentPackageRoot: newRoot,
    exitFn: () => { requestedExit = true; },
  });
  await waitForChildExit(oldServer.child);

  assert.equal(requestedExit, false, "a stale installation must not trigger duplicate success");
  assert.equal(await canBind(oldServer.port), true, "cleanup should release the stale server port");

  const replacement = await spawnHealthyServeFixture(newEntry, oldServer.port);
  t.after(() => replacement.child.kill("SIGKILL"));
  assert.equal(replacement.port, oldServer.port, "the new installation should take over the same port");
});

test("ensurePortFree replaces an old runtime after an in-place upgrade", async (t) => {
  if (!hasLsof()) return t.skip("requires lsof");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tt-serve-in-place-upgrade-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const entry = createHealthyServeFixture(root, "0.0.0-stale");
  const oldServer = await spawnHealthyServeFixture(entry);
  t.after(() => oldServer.child.kill("SIGKILL"));

  let requestedExit = false;
  await ensurePortFree(oldServer.port, {
    currentPackageRoot: root,
    exitFn: () => { requestedExit = true; },
  });
  await waitForChildExit(oldServer.child);

  assert.equal(requestedExit, false, "an old runtime at the same path must be replaced");

  // Simulate the package files being overwritten in place by an update.
  createHealthyServeFixture(root, CURRENT_PACKAGE_VERSION);
  const replacement = await spawnHealthyServeFixture(entry, oldServer.port);
  t.after(() => replacement.child.kill("SIGKILL"));
  assert.equal(replacement.port, oldServer.port);
});

// Proves ensurePortFree consults the identity check rather than merely owning
// one: a unit test of isTokenTrackerServeCommand alone still passes if the
// filter is deleted from the kill path.
test("ensurePortFree leaves an unrelated listener running", async (t) => {
  if (!hasLsof()) return t.skip("ensurePortFree is a no-op without lsof");

  // A separate process, because ensurePortFree skips its own pid for free.
  const child = cp.spawn(
    process.execPath,
    [
      "-e",
      "const n=require('net');n.createServer(c=>c.on('error',()=>{}))" +
        ".listen(0,'127.0.0.1',function(){process.stdout.write(String(this.address().port))});" +
        "setInterval(()=>{},1000);",
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  t.after(() => child.kill("SIGKILL"));

  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("listener never reported a port")), 10000);
    child.stdout.once("data", (chunk) => {
      clearTimeout(timer);
      resolve(Number(String(chunk).trim()));
    });
  });
  assert.ok(port > 0, "child should report its port");

  await ensurePortFree(port);

  assert.equal(child.exitCode, null, "an unrelated listener must survive port cleanup");
  assert.equal(child.signalCode, null, "an unrelated listener must not be signalled");
});
