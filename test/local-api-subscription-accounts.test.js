const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createLocalApiHandler } = require("../src/lib/local-api");

test("account API protects reads and mutations, rejects foreign origins, and serves creation/login commands", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tt-accounts-api-"));
  t.mock.method(os, "homedir", () => dir);
  const handler = createLocalApiHandler({ queuePath: path.join(dir, "queue.jsonl") });
  const server = http.createServer((req, res) => { handler(req, res, new URL(req.url, "http://localhost")).catch(() => { res.statusCode = 500; res.end(); }); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await fs.rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const endpoint = base + "/functions/tokentracker-subscription-accounts";
  assert.equal((await fetch(endpoint)).status, 401);
  assert.equal((await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "launch", id: "system-codex" }) })).status, 401);
  for (const action of ["switch_session", "session_rotation", "activate", "restore_default", "refresh_system", "delete"]) {
    assert.equal((await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, sessionId: "fake", id: "fake", auto: true }) })).status, 401);
  }
  const { token } = await (await fetch(base + "/api/local-auth")).json();
  const headers = { "x-tokentracker-local-auth": token, Origin: base, "Content-Type": "application/json" };
  assert.equal((await fetch(endpoint, { headers: { ...headers, Origin: "https://foreign.invalid" } })).status, 401);
  const created = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ action: "create", provider: "codex", label: "Work" }) });
  assert.equal(created.status, 200); assert.equal(created.headers.get("cache-control"), "no-store");
  const { account } = await created.json();
  assert.equal(account.label, "Work"); assert.equal(account.identity, undefined);
  const list = await (await fetch(endpoint, { headers })).json();
  assert.equal(list.accounts.length, 1); assert.match(list.poolCommands.codex, /auto/);
  assert.deepEqual(list.sessions, []);
  const detail = await (await fetch(endpoint + "?id=" + account.id, { headers })).json();
  assert.equal(detail.status, "login_required"); assert.match(detail.commands.login, /login/);
  assert.equal((await fetch(endpoint + "?id=..", { headers })).status, 400);
  assert.equal((await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ action: "launch", id: "../escape" }) })).status, 400);
  assert.equal((await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ action: "switch_session", sessionId: "../escape", id: account.id }) })).status, 400);
  assert.equal((await fetch(endpoint, { method: "DELETE", headers })).status, 405);
});
