const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createCursorLogin, readCursorConnection, cursorSessionPath } = require("../src/lib/cursor-login");
const { extractCursorAuth, isCursorInstalled } = require("../src/lib/cursor-config");

function token(sub = "auth0|user_test", exp = Math.floor(Date.now() / 1000) + 3600) {
  return `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ sub, exp })).toString("base64url")}.signature`;
}
function fixture(t, options = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-cursor-login-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const trackerDir = path.join(home, ".tokentracker", "tracker");
  return { home, trackerDir, login: createCursorLogin({ trackerDir, ...options }) };
}
const response = (status, body = {}) => ({ status, ok: status === 200, json: async () => body });

test("login keeps the PKCE verifier server-side and stores only an API-validated session", async (t) => {
  const jwt = token();
  let pollUrl;
  let validated = false;
  const f = fixture(t, {
    fetchImpl: async (url, init) => {
      pollUrl = new URL(url);
      assert.equal(init.redirect, "error");
      return response(200, { accessToken: jwt, refreshToken: "never-persist-this" });
    },
    validateSession: async (auth) => {
      assert.equal(auth.cookie, `WorkosCursorSessionToken=user_test%3A%3A${jwt}`);
      assert.equal(fs.existsSync(cursorSessionPath(f)), false);
      validated = true;
    },
  });
  const start = f.login.start();
  const url = new URL(start.authUrl);
  assert.equal(url.origin, "https://cursor.com");
  assert.equal(url.pathname, "/loginDeepControl");
  assert.equal(url.searchParams.get("redirectTarget"), "cli");
  assert.equal(url.searchParams.has("verifier"), false);
  assert.equal(start.verifier, undefined);
  const result = await f.login.poll(start.attemptId);
  assert.equal(result.status, "connected");
  assert.equal(validated, true);
  assert.equal(pollUrl.origin, "https://api2.cursor.sh");
  const challenge = crypto.createHash("sha256").update(pollUrl.searchParams.get("verifier")).digest("base64url");
  assert.equal(url.searchParams.get("challenge"), challenge);
  const stored = fs.readFileSync(cursorSessionPath(f), "utf8");
  assert.ok(!stored.includes("never-persist-this"));
  assert.ok(!JSON.stringify(result).includes(jwt));
  assert.equal(readCursorConnection(f).status, "connected");
  assert.equal(extractCursorAuth(f).accessToken, jwt);
  assert.equal(isCursorInstalled(f), true);
  if (process.platform !== "win32") assert.equal(fs.statSync(cursorSessionPath(f)).mode & 0o777, 0o600);
});

test("404 remains pending without writing credentials", async (t) => {
  const f = fixture(t, { fetchImpl: async () => response(404) });
  const start = f.login.start();
  assert.equal((await f.login.poll(start.attemptId)).status, "pending");
  assert.equal(readCursorConnection(f).status, "disconnected");
});

test("failed or malformed authorization never persists secrets or echoes upstream errors", async (t) => {
  for (const result of [response(403), response(200, { accessToken: "cursor-safe-storage:v1:secret" }), response(200, { accessToken: token("invalid") }), response(200, { accessToken: token(undefined, 1) })]) {
    const f = fixture(t, { fetchImpl: async () => result });
    const start = f.login.start();
    assert.equal((await f.login.poll(start.attemptId)).status, "failed");
    assert.equal(fs.existsSync(cursorSessionPath(f)), false);
  }
  const f = fixture(t, { fetchImpl: async () => { throw new Error("secret-response"); } });
  const start = f.login.start();
  const result = await f.login.poll(start.attemptId);
  assert.equal(result.status, "pending");
  assert.ok(!JSON.stringify(result).includes("secret-response"));
});

test("rejected usage credentials preserve the previous working connection", async (t) => {
  let rejected = false;
  const f = fixture(t, {
    fetchImpl: async () => response(200, { accessToken: token() }),
    validateSession: async () => { if (rejected) throw new Error("token secret rejected"); },
  });
  await f.login.poll(f.login.start().attemptId);
  const before = fs.readFileSync(cursorSessionPath(f), "utf8");
  rejected = true;
  assert.equal((await f.login.poll(f.login.start().attemptId)).status, "failed");
  assert.equal(fs.readFileSync(cursorSessionPath(f), "utf8"), before);
});

test("expiry and cancellation end the flow without polling or saving", async (t) => {
  let now = Date.now();
  let calls = 0;
  const f = fixture(t, { now: () => now, fetchImpl: async () => { calls++; return response(404); } });
  const start = f.login.start();
  now += 10 * 60 * 1000;
  assert.equal((await f.login.poll(start.attemptId)).status, "expired");
  const next = f.login.start();
  f.login.cancel(next.attemptId);
  assert.equal((await f.login.poll(next.attemptId)).status, "expired");
  assert.equal(calls, 0);
});

test("concurrent polls share one request; cancelled in-flight results cannot save", async (t) => {
  let finish;
  let calls = 0;
  const f = fixture(t, {
    fetchImpl: () => { calls++; return new Promise((resolve) => { finish = resolve; }); },
    validateSession: async () => {},
  });
  const start = f.login.start();
  const p1 = f.login.poll(start.attemptId);
  const p2 = f.login.poll(start.attemptId);
  f.login.cancel(start.attemptId);
  finish(response(200, { accessToken: token() }));
  assert.equal((await p1).status, "expired");
  assert.equal((await p2).status, "expired");
  assert.equal(calls, 1);
  assert.equal(fs.existsSync(cursorSessionPath(f)), false);
});

test("saved sessions work in a fresh process and disconnect only removes TokenTracker's copy", async (t) => {
  const f = fixture(t, { fetchImpl: async () => response(200, { accessToken: token() }), validateSession: async () => {} });
  await f.login.poll(f.login.start().attemptId);
  const cp = require("node:child_process");
  const output = cp.execFileSync(process.execPath, ["-e", `const {extractCursorAuth}=require('./src/lib/cursor-config');const auth=extractCursorAuth(${JSON.stringify({ home: f.home, trackerDir: f.trackerDir })});process.stdout.write(JSON.stringify({connected:!!auth,source:auth?.source}));`], { cwd: path.resolve(__dirname, ".."), encoding: "utf8" });
  assert.deepEqual(JSON.parse(output), { connected: true, source: "browser" });
  const unrelated = path.join(f.trackerDir, "keep.json");
  fs.writeFileSync(unrelated, "keep");
  f.login.disconnect();
  assert.equal(readCursorConnection(f).status, "disconnected");
  assert.equal(fs.readFileSync(unrelated, "utf8"), "keep");
});

test("a newer login survives a cancelled older response body", async (t) => {
  let finishBody;
  let calls = 0;
  const f = fixture(t, { fetchImpl: async () => { calls++; return { status: 200, ok: true, json: () => new Promise(resolve => { finishBody = resolve; }) }; } });
  const first = f.login.start();
  const polling = f.login.poll(first.attemptId);
  await new Promise(resolve => setImmediate(resolve));
  const second = f.login.start();
  finishBody({});
  assert.equal((await polling).status, "expired");
  const secondPoll = f.login.poll(second.attemptId);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2);
  f.login.cancel(second.attemptId);
  finishBody({});
  assert.equal((await secondPoll).status, "expired");
  assert.equal(fs.existsSync(cursorSessionPath(f)), false);
});

test("an expired or corrupt explicit connection never falls back to another account", (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.trackerDir, { recursive: true });
  for (const contents of [JSON.stringify({ accessToken: token(undefined, 1) }), "invalid-json"]) {
    fs.writeFileSync(cursorSessionPath(f), contents, { mode: 0o600 });
    assert.equal(readCursorConnection(f).status, "expired");
    assert.equal(extractCursorAuth({ ...f, deps: { execFileSync: () => { throw new Error("must not read Cursor DB"); } } }), null);
  }
});
