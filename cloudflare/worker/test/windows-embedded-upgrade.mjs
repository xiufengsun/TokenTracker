import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const [legacy, candidate] = process.argv.slice(2);
assert.ok(legacy && candidate, "Pass the legacy and candidate EmbeddedServer directories");
const scratch = await mkdtemp(join(tmpdir(), "tt-windows-upgrade-"));
const tracker = join(scratch, ".tokentracker", "tracker");
const cookies = join(tracker, "relay-cookies.json");
const fixture = join(scratch, "fixture.cjs");
const owner = "22139caf-59b0-4e4d-b0a1-26243b3095f5";
const versionFile = async (root) =>
  JSON.parse(await readFile(join(root, "tokentracker", "package.json"), "utf8")).version;

async function getUnusedPort() {
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const { port } = socket.address();
  await new Promise((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function verifyRuntime(root, expectedRefresh, rotateTo) {
  const port = await getUnusedPort();
  const url = "http://127.0.0.1:" + port;
  const child = spawn(join(root, "node.exe"), [
    "--require", fixture, join(root, "tokentracker", "bin", "tracker.js"),
    "serve", "--no-sync", "--no-open", "--port", String(port),
  ], {
    cwd: scratch,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOME: scratch,
      USERPROFILE: scratch,
      APPDATA: scratch,
      LOCALAPPDATA: scratch,
      TOKENTRACKER_NO_TELEMETRY: "1",
      TOKENTRACKER_NO_AUTO_UPDATE: "1",
      TOKENTRACKER_CLOUDFLARE_DUAL_WRITE: root === candidate ? "1" : "0",
      TOKENTRACKER_CLOUDFLARE_READS: root === candidate ? "1" : "0",
      TT_LOCAL_FIXTURE_OWNER: owner,
      TT_LOCAL_FIXTURE_REFRESH_IN: expectedRefresh,
      TT_LOCAL_FIXTURE_REFRESH_OUT: rotateTo,
    },
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output = (output + chunk).slice(-8000); });
  child.stderr.on("data", (chunk) => { output = (output + chunk).slice(-8000); });
  try {
    let page;
    for (let attempt = 0; attempt < 80; attempt++) {
      if (child.exitCode !== null) break;
      page = await fetch(url + "/", { signal: AbortSignal.timeout(500) }).catch(() => null);
      if (page?.ok) break;
      await delay(125);
    }
    assert.ok(page?.ok, "Embedded server did not serve its dashboard: " + output);
    const html = await page.text();
    assert.match(html, /<script.*assets\//);
    const runtime = await fetch(url + "/api/runtime-config.js");
    assert.equal(runtime.status, 200);
    const config = await runtime.text();
    assert.match(config, /srctyff5[.]us-east[.]insforge[.]app/);
    if (root === candidate) assert.match(config, /"cloudflareReads":true/);
    const refresh = await fetch(url + "/api/auth/refresh", {
      method: "POST",
      headers: { Origin: url, "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(refresh.status, 200, "Embedded relay refresh failed");
    assert.equal((await refresh.json()).user.id, owner);
    const persisted = JSON.parse(await readFile(cookies, "utf8"));
    assert.ok(persisted.insforge_refresh_token.includes(rotateTo));
    return port;
  } finally {
    if (child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
  }
}

try {
  await mkdir(tracker, { recursive: true });
  await writeFile(join(tracker, "config.json"), "{}");
  await writeFile(join(tracker, "queue.jsonl"), "");
  await writeFile(cookies, JSON.stringify({
    insforge_refresh_token: "insforge_refresh_token=original-session; Path=/; HttpOnly",
  }));
  await writeFile(fixture, [
    'globalThis.fetch = async (input, options) => {',
    '  const url = new URL(String(input));',
    '  if (url.hostname !== "srctyff5.us-east.insforge.app" || url.pathname !== "/api/auth/refresh")',
    '    throw new Error("External network disabled in embedded upgrade fixture");',
    '  const body = JSON.parse(options.body);',
    '  if (body.refresh_token !== process.env.TT_LOCAL_FIXTURE_REFRESH_IN) return new Response(null,{status:401});',
    '  const owner = process.env.TT_LOCAL_FIXTURE_OWNER;',
    '  const accessToken = [Buffer.from(JSON.stringify({alg:"HS256"})).toString("base64url"),',
    '    Buffer.from(JSON.stringify({sub:owner, exp:Math.floor(Date.now()/1000)+3600})).toString("base64url"),',
    '    "fixture-signature"].join(".");',
    '  return Response.json({accessToken,refreshToken:process.env.TT_LOCAL_FIXTURE_REFRESH_OUT,user:{id:owner}});',
    '};',
    '',
  ].join("\n"));
  const prior = await verifyRuntime(legacy, "original-session", "legacy-rotation");
  const next = await verifyRuntime(candidate, "legacy-rotation", "candidate-rotation");
  assert.notEqual(prior, next, "Use a distinct loopback port to exercise cookie-less recovery");
  console.log("PASS: embedded Windows runtime " + await versionFile(legacy) + " -> " +
    await versionFile(candidate) + " retained and rotated the same account across a port change");
} finally {
  await rm(scratch, { recursive: true, force: true, maxRetries: 5 });
}
