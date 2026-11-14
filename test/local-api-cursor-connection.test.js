const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const { test, beforeEach, afterEach } = require("node:test");
let tmpHome;
beforeEach(() => { tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "tt-cursor-connection-api-")); });
afterEach(() => { fs.rmSync(tmpHome, { recursive: true, force: true }); });
function freshHandler(queuePath) {
  delete require.cache[require.resolve("../src/lib/local-api")];
  const { createLocalApiHandler } = require("../src/lib/local-api");
  return createLocalApiHandler({ queuePath });
}

function makeQueuePath() {
  const queuePath = path.join(tmpHome, ".tokentracker", "tracker", "queue.jsonl");
  fs.mkdirSync(path.dirname(queuePath), { recursive: true });
  fs.writeFileSync(queuePath, "");
  return queuePath;
}

function makeReq({ method = "GET", urlObj, headers = {}, body } = {}) {
  const base = Readable.from(body != null ? [Buffer.from(body)] : []);
  base.method = method;
  base.url = urlObj.pathname + urlObj.search;
  base.headers = { host: "localhost", ...headers };
  return base;
}

function makeRes() {
  const chunks = [];
  const headers = {};
  return {
    statusCode: 200,
    _headers: headers,
    setHeader(k, v) {
      headers[k.toLowerCase()] = v;
    },
    writeHead(status, hdrs) {
      this.statusCode = status;
      if (hdrs) for (const [k, v] of Object.entries(hdrs)) headers[k.toLowerCase()] = v;
    },
    end(body) {
      if (body) chunks.push(body);
    },
    body() {
      return chunks.join("");
    },
    json() {
      return JSON.parse(chunks.join(""));
    },
  };
}

async function call(handler, opts) {
  const urlObj = new URL(`http://localhost${opts.endpoint}`);
  const req = makeReq({ ...opts, urlObj });
  const res = makeRes();
  const handled = await handler(req, res, urlObj);
  assert.ok(handled, `endpoint must be handled: ${opts.endpoint}`);
  return res;
}

async function authToken(handler) {
  const authRes = await call(handler, { endpoint: "/api/local-auth" });
  return authRes.json().token;
}


test("all connection operations require same-origin local authorization", async () => {
  const handler = freshHandler(makeQueuePath());
  const token = await authToken(handler);
  for (const action of [null, "start", "poll", "cancel", "disconnect"]) {
    const request = { endpoint: "/functions/tokentracker-cursor-connection", method: action ? "POST" : "GET", ...(action ? { body: JSON.stringify({ action }) } : {}) };
    assert.equal((await call(handler, request)).statusCode, 401);
    assert.equal((await call(handler, { ...request, headers: { "x-tokentracker-local-auth": token, origin: "https://attacker.invalid" } })).statusCode, 401);
  }
});

test("start/poll/cancel expose no verifier or credentials and never contact Cursor before polling", async () => {
  const handler = freshHandler(makeQueuePath());
  const headers = { "x-tokentracker-local-auth": await authToken(handler) };
  const endpoint = "/functions/tokentracker-cursor-connection";
  const status = await call(handler, { endpoint, headers });
  assert.deepEqual(status.json(), { status: "disconnected" });
  assert.equal(status._headers["cache-control"], "no-store");
  const start = (await call(handler, { endpoint, headers, method: "POST", body: JSON.stringify({ action: "start" }) })).json();
  assert.equal(start.status, "pending");
  assert.equal(start.verifier, undefined);
  assert.equal(start.accessToken, undefined);
  assert.equal(new URL(start.authUrl).origin, "https://cursor.com");
  const cancel = await call(handler, { endpoint, headers, method: "POST", body: JSON.stringify({ action: "cancel", attemptId: start.attemptId }) });
  assert.equal(cancel.json().status, "cancelled");
  const expired = await call(handler, { endpoint, headers, method: "POST", body: JSON.stringify({ action: "poll", attemptId: start.attemptId }) });
  assert.equal(expired.json().status, "expired");
  assert.equal((await call(handler, { endpoint, headers, method: "POST", body: "invalid" })).statusCode, 400);
  assert.equal((await call(handler, { endpoint, headers, method: "POST", body: JSON.stringify({ action: "unknown" }) })).statusCode, 400);
  assert.equal((await call(handler, { endpoint, headers, method: "DELETE" })).statusCode, 405);
});
