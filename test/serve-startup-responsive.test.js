const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { test } = require("node:test");

async function get(port, pathname) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: "127.0.0.1", port, path: pathname, timeout: 3000 }, (response) => {
      let body = "";
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body }));
      response.on("error", reject);
    });
    request.on("timeout", () => request.destroy(new Error("Listener blocked on runtime maintenance")));
    request.on("error", reject);
  });
}

for (const firstRun of [true, false]) {
  test(`dashboard and health respond during runtime refresh (firstRun=${firstRun})`, { timeout: 20000 }, async (t) => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "tt-serve-startup-"));
    const trackerDir = path.join(home, ".tokentracker", "tracker");
    await fs.mkdir(trackerDir, { recursive: true });
    if (!firstRun) await fs.writeFile(path.join(trackerDir, "cursors.json"), "{}");
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1");
    await once(probe, "listening");
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    const child = spawn(process.execPath, [path.join(__dirname, "fixtures", "serve-slow-startup.cjs"), String(port)], {
      env: { ...process.env, HOME: home, USERPROFILE: home, TOKENTRACKER_APP_SHELL: "", TOKENTRACKER_NO_TELEMETRY: "1" },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = once(child, "close");
        child.kill("SIGKILL");
        await closed;
      }
      await fs.rm(home, { recursive: true, force: true });
    });
    const phases = [];
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("message", ({ phase }) => phases.push(phase));
    async function waitFor(phase) {
      const deadline = Date.now() + 10000;
      while (!phases.includes(phase)) {
        assert.equal(child.exitCode, null, output);
        assert.ok(Date.now() < deadline, `Timed out waiting for ${phase}: ${output}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    await waitFor("install");
    const health = await get(port, "/api/local-auth");
    assert.equal(health.status, 200);
    assert.equal(JSON.parse(health.body).serverVersion, require("../package.json").version);
    const page = await get(port, "/");
    assert.equal(page.status, 200);
    assert.match(page.body, /<html/i);
    assert.deepEqual(phases, ["install"], "HTTP must work before maintenance is released");
    child.send("continue");
    await waitFor("complete");
    assert.deepEqual(phases, ["install", "repair", firstRun ? "init" : "sync", "complete"]);
  });
}
