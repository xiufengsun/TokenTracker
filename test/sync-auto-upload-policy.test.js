"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { test } = require("node:test");

async function setup(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "tt-auto-upload-policy-"));
  const tracker = path.join(home, ".tokentracker", "tracker");
  await fs.mkdir(tracker, { recursive: true });
  await fs.writeFile(path.join(tracker, "cloud-sync-pref.json"), JSON.stringify({ enabled: true }));
  const requests = [];
  let status = 200;
  const server = http.createServer((req, res) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => {
      if (req.url === "/functions/tokentracker-ingest") requests.push(JSON.parse(data));
      res.writeHead(req.url === "/functions/tokentracker-ingest" ? status : 200, {
        "Content-Type": "application/json", ...(status === 429 ? { "Retry-After": "120" } : {}),
      });
      res.end(JSON.stringify(status === 200 ? { ok: true, inserted: 1, skipped: 0 } : { error: "test failure" }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await fs.rm(home, { recursive: true, force: true }); });
  await fs.writeFile(path.join(tracker, "config.json"), JSON.stringify({ baseUrl: `http://127.0.0.1:${server.address().port}`, deviceToken: "fixture-token" }));
  const queue = path.join(tracker, "queue.jsonl");
  const row = (tokens) => ({ source: "fixture", model: "fixture-model", hour_start: "2026-10-01T00:00:00.000Z", input_tokens: tokens, output_tokens: 0, cached_input_tokens: 0, cache_creation_input_tokens: 0, reasoning_output_tokens: 0, total_tokens: tokens, billable_total_tokens: tokens, total_cost_usd: 0, conversation_count: 1 });
  const append = async (record) => fs.appendFile(queue, `${JSON.stringify(record)}\n`);
  const readState = async () => JSON.parse(await fs.readFile(path.join(tracker, "queue.state.json"), "utf8"));
  const run = (args) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, "../bin/tracker.js"), "sync", ...args], {
      env: {
        PATH: path.dirname(process.execPath), SystemRoot: process.env.SystemRoot || "",
        HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, ".codex"),
        APPDATA: path.join(home, "AppData", "Roaming"), LOCALAPPDATA: path.join(home, "AppData", "Local"),
        XDG_DATA_HOME: path.join(home, ".local", "share"),
        TOKENTRACKER_AUTO_RETRY_NO_SPAWN: "1", TOKENTRACKER_WSL_MODE: "native-only",
      },
    });
    let stderr = "";
    child.stdout.resume(); child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject); child.on("exit", (code) => resolve({ code, stderr }));
  });
  return { tracker, queue, requests, setStatus: (value) => { status = value; }, row, append, readState, run };
}

test("ordinary auto hooks throttle uploads but a manual drain preserves a downward correction", async (t) => {
  const x = await setup(t);
  await x.append(x.row(100));
  assert.equal((await x.run(["--auto"])).code, 0);
  const firstOffset = (await x.readState()).offset;
  await x.append(x.row(40));
  assert.equal((await x.run(["--auto"])).code, 0);
  assert.equal(x.requests.length, 1);
  assert.equal((await x.readState()).offset, firstOffset);
  assert.equal((await x.run(["--drain"])).code, 0);
  assert.equal(x.requests.length, 2);
  assert.equal(x.requests[1].hourly[0].total_tokens, 40);
  assert.equal((await x.readState()).offset, (await fs.stat(x.queue)).size);
  const throttle = JSON.parse(await fs.readFile(path.join(x.tracker, "upload.throttle.json"), "utf8"));
  assert.ok(throttle.nextAllowedAtMs - throttle.lastSuccessMs >= 300_000);
  assert.ok(throttle.nextAllowedAtMs - throttle.lastSuccessMs <= 360_000);
});

test("429 backoff blocks ordinary and native automatic retries, including an automatic drain", async (t) => {
  const x = await setup(t);
  await x.append(x.row(100));
  x.setStatus(429);
  assert.equal((await x.run(["--auto"])).code, 0);
  assert.equal((await x.run(["--auto"])).code, 0);
  assert.equal((await x.run(["--auto", "--background", "--publish-account"])).code, 0);
  assert.equal((await x.run(["--auto", "--drain"])).code, 1);
  assert.equal(x.requests.length, 1);
  const failure = JSON.parse(await fs.readFile(path.join(x.tracker, "upload.throttle.json"), "utf8"));
  assert.equal(failure.lastErrorStatus, 429);
  assert.equal(failure.lastErrorCode, "CLOUD_UPLOAD_FAILED");
  x.setStatus(200);
  assert.equal((await x.run(["--drain"])).code, 0);
  assert.equal(x.requests.length, 2);
});

test("native publication owns its cadence while automatic drains retain state-only and repair replay", async (t) => {
  const x = await setup(t);
  await x.append(x.row(100));
  assert.equal((await x.run(["--auto"])).code, 0);
  await x.append(x.row(40));
  assert.equal((await x.run(["--auto", "--background", "--publish-account"])).code, 0);
  assert.equal(x.requests.length, 2);
  const stateRecord = { kind: "account_session_state", source: "trae-cn", session_id: "fixture-session", model: "fixture-model", bucket_start: "2026-10-01T00:00:00Z", snapshot_verified_at: "2026-10-02T00:00:00Z", input_tokens: 20, output_tokens: 0, cached_input_tokens: 0, cache_creation_input_tokens: 0, reasoning_output_tokens: 0, total_tokens: 20 };
  await x.append(stateRecord);
  assert.equal((await x.run(["--auto", "--drain"])).code, 0);
  assert.equal(x.requests[2].hourly.length, 0);
  assert.equal(x.requests[2].account_session_states.length, 1);
  await fs.writeFile(path.join(x.tracker, "queue.state.json"), JSON.stringify({ offset: 0, note: "fixture-repair" }));
  assert.equal((await x.run(["--auto", "--drain"])).code, 0);
  assert.equal(x.requests[3].hourly[0].total_tokens, 40);
  assert.equal(x.requests[3].account_session_states.length, 1);
  assert.equal((await x.readState()).offset, (await fs.stat(x.queue)).size);
});

test("upgrade caps an old thirty-minute success deadline without discarding pending usage", async (t) => {
  const x = await setup(t);
  await x.append(x.row(100));
  assert.equal((await x.run(["--auto"])).code, 0);
  await x.append(x.row(40));
  const filename = path.join(x.tracker, "upload.throttle.json");
  const prior = JSON.parse(await fs.readFile(filename, "utf8"));
  prior.lastSuccessMs = Date.now() - 7 * 60_000;
  prior.nextAllowedAtMs = prior.lastSuccessMs + 30 * 60_000;
  await fs.writeFile(filename, JSON.stringify(prior));
  assert.equal((await x.run(["--auto"])).code, 0);
  assert.equal(x.requests.length, 2);
  assert.equal(x.requests[1].hourly[0].total_tokens, 40);
});
