const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const { pathToFileURL } = require("node:url");
const { test } = require("node:test");

const repoRoot = path.resolve(__dirname, "..");

async function request(middleware, pathname, { method = "GET" } = {}) {
  const req = Readable.from([]);
  req.method = method;
  req.url = pathname;
  req.headers = { host: "localhost:5173" };
  const headers = {};
  let statusCode = 200;
  let nextCalled = false;
  const result = await new Promise((resolve, reject) => {
    const res = {
      get statusCode() { return statusCode; },
      set statusCode(value) { statusCode = value; },
      setHeader(name, value) { headers[String(name).toLowerCase()] = value; },
      writeHead(code, values = {}) {
        statusCode = code;
        Object.entries(values).forEach(([name, value]) => this.setHeader(name, value));
      },
      end(body = "") { resolve({ body: String(body), headers, statusCode }); },
    };
    middleware(req, res, (error) => {
      if (error) reject(error);
      else {
        nextCalled = true;
        resolve({ body: "", headers, statusCode });
      }
    });
  });
  return { ...result, nextCalled };
}

test("Vite dev server handles the current repo pet API instead of an installed CLI", async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-vite-pet-api-"));
  process.env.TOKENTRACKER_PETS_DIR = path.join(sandbox, "pets");
  process.env.TOKENTRACKER_CODEX_PETS_DIR = path.join(sandbox, "codex-pets");
  process.env.TOKENTRACKER_CODEX_ASAR = path.join(sandbox, "no-such-app.asar");
  try {
    const configUrl = `${pathToFileURL(path.join(repoRoot, "dashboard/vite.config.js")).href}?pet-api-test=${Date.now()}`;
    const { default: createConfig } = await import(configUrl);
    const config = createConfig({ mode: "development", command: "serve" });
    const plugin = config.plugins.find((item) => item?.name === "tokentracker-local-data-api");
    let middleware;
    plugin.configureServer({ middlewares: { use(value) { middleware = value; } } });

    const auth = await request(middleware, "/api/local-auth");
    assert.equal(auth.nextCalled, false);
    assert.equal(auth.statusCode, 200);
    assert.match(JSON.parse(auth.body).token, /^[a-f0-9]{48}$/);

    const pets = await request(middleware, "/functions/tokentracker-pets");
    assert.equal(pets.nextCalled, false);
    assert.equal(pets.statusCode, 200);
    assert.deepEqual(JSON.parse(pets.body), { pets: [], hiddenBuiltinIds: [] });

    const upload = await request(middleware, "/api/pets/import", { method: "POST" });
    assert.equal(upload.nextCalled, false);
    assert.equal(upload.statusCode, 401);
    assert.equal(JSON.parse(upload.body).error, "Unauthorized");
  } finally {
    delete process.env.TOKENTRACKER_PETS_DIR;
    delete process.env.TOKENTRACKER_CODEX_PETS_DIR;
    delete process.env.TOKENTRACKER_CODEX_ASAR;
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("Vite dev server handles current repo session analytics instead of an installed CLI", async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-vite-session-api-"));
  const previousHome = process.env.HOME;
  const previousFetch = global.fetch;
  process.env.HOME = sandbox;
  global.fetch = async () => new Response(JSON.stringify({ error: "stale local CLI" }), {
    status: 404,
    headers: { "content-type": "application/json" },
  });
  try {
    const configUrl = `${pathToFileURL(path.join(repoRoot, "dashboard/vite.config.js")).href}?session-api-test=${Date.now()}`;
    const { default: createConfig } = await import(configUrl);
    const config = createConfig({ mode: "development", command: "serve" });
    const plugin = config.plugins.find((item) => item?.name === "tokentracker-local-data-api");
    let middleware;
    plugin.configureServer({ middlewares: { use(value) { middleware = value; } } });

    const context = await request(middleware, "/functions/tokentracker-context-health");
    assert.equal(context.nextCalled, false);
    assert.equal(context.statusCode, 200);
    assert.equal(typeof JSON.parse(context.body).estimated_fixed_tokens, "number");

    const sessions = await request(middleware, "/functions/tokentracker-session-insights");
    assert.equal(sessions.nextCalled, false);
    assert.equal(sessions.statusCode, 200);
    assert.equal(typeof JSON.parse(sessions.body).available, "boolean");

    const browser = await request(middleware, "/functions/tokentracker-sessions?limit=25");
    const browserPayload = JSON.parse(browser.body);
    assert.equal(browser.nextCalled, false);
    assert.equal(browser.statusCode, 200);
    assert.equal(browser.headers["cache-control"], "no-store");
    assert.equal(browser.headers["x-content-type-options"], "nosniff");
    assert.equal(typeof browserPayload.available, "boolean");
    assert.equal(Array.isArray(browserPayload.sessions), true);
    assert.equal(browserPayload.returned_count, browserPayload.sessions.length);
  } finally {
    global.fetch = previousFetch;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
