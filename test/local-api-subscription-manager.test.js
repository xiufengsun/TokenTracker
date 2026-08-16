const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, before, describe, it } = require("node:test");

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "tt-localapi-subscriptions-"));
// The subscription store lives next to queue.jsonl (path.dirname(qp)), so a
// sandboxed queuePath isolates the whole test from the real ~/.tokentracker.
const queuePath = path.join(sandbox, "tracker", "queue.jsonl");
const { createLocalApiHandler } = require("../src/lib/local-api");

function request({ method = "GET", pathname, headers = {}, body }) {
  const url = new URL(`http://localhost${pathname}`);
  const listeners = {};
  const req = {
    method,
    headers: { host: "localhost", ...headers },
    on(event, listener) { listeners[event] = listener; return req; },
  };
  process.nextTick(() => {
    if (body != null) listeners.data?.(Buffer.from(JSON.stringify(body)));
    listeners.end?.();
  });
  return { req, url };
}

function response() {
  let status = 200;
  let body = "";
  return {
    writeHead(code) { status = code; },
    end(chunk) { if (chunk) body += chunk; },
    get result() { return { status, body: body ? JSON.parse(body) : null }; },
  };
}

async function call(handler, options) {
  const { req, url } = request(options);
  const res = response();
  assert.equal(await handler(req, res, url), true);
  return res.result;
}

const VALID_SUBSCRIPTION = {
  service: "GPT",
  plan: "Plus",
  autoRenew: true,
  // Beijing (UTC+8) 2026-08-16 14:00.
  nextBillingAt: Date.UTC(2026, 7, 16, 6, 0),
};

describe("local subscription manager API", () => {
  let handler;
  let token;

  before(async () => {
    handler = createLocalApiHandler({ queuePath });
    token = (await call(handler, { pathname: "/api/local-auth" })).body.token;
  });

  after(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it("lists an empty store before any subscription is created", async () => {
    const listed = await call(handler, { pathname: "/functions/tokentracker-subscription-manager" });
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.subscriptions, []);
  });

  it("rejects mutations without the loopback auth token", async () => {
    const unauthorized = await call(handler, {
      method: "POST",
      pathname: "/functions/tokentracker-subscription-manager",
      headers: { origin: "http://localhost:7680" },
      body: { action: "create", subscription: VALID_SUBSCRIPTION },
    });
    assert.equal(unauthorized.status, 401);
  });

  it("creates, lists, updates and deletes a subscription", async () => {
    const auth = { origin: "http://localhost:7680", "x-tokentracker-local-auth": token };

    const created = await call(handler, {
      method: "POST",
      pathname: "/functions/tokentracker-subscription-manager",
      headers: auth,
      body: { action: "create", subscription: VALID_SUBSCRIPTION },
    });
    assert.equal(created.status, 200);
    assert.equal(created.body.ok, true);
    assert.ok(created.body.subscription.id);
    assert.equal(created.body.subscription.service, "GPT");
    // Epoch ms input is stored as a minute-precision UTC ISO string.
    assert.equal(created.body.subscription.nextBillingAt, "2026-08-16T06:00:00.000Z");

    // The store file lands next to queue.jsonl.
    const storePath = path.join(path.dirname(queuePath), "subscription-manager.json");
    assert.equal(fs.existsSync(storePath), true);

    const listed = await call(handler, { pathname: "/functions/tokentracker-subscription-manager" });
    assert.equal(listed.body.subscriptions.length, 1);
    assert.equal(listed.body.subscriptions[0].id, created.body.subscription.id);

    const updated = await call(handler, {
      method: "POST",
      pathname: "/functions/tokentracker-subscription-manager",
      headers: auth,
      body: {
        action: "update",
        id: created.body.subscription.id,
        subscription: { autoRenew: false, nextBillingAt: "2026-09-30T12:00:00.000Z" },
      },
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.subscription.autoRenew, false);
    assert.equal(updated.body.subscription.nextBillingAt, "2026-09-30T12:00:00.000Z");
    assert.equal(updated.body.subscription.service, "GPT");

    const deleted = await call(handler, {
      method: "POST",
      pathname: "/functions/tokentracker-subscription-manager",
      headers: auth,
      body: { action: "delete", id: created.body.subscription.id },
    });
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.removed, true);

    const emptied = await call(handler, { pathname: "/functions/tokentracker-subscription-manager" });
    assert.deepEqual(emptied.body.subscriptions, []);
  });

  it("rejects invalid input with 400", async () => {
    const auth = { origin: "http://localhost:7680", "x-tokentracker-local-auth": token };

    const missingService = await call(handler, {
      method: "POST",
      pathname: "/functions/tokentracker-subscription-manager",
      headers: auth,
      body: {
        action: "create",
        subscription: { plan: "Plus", autoRenew: true, nextBillingAt: Date.UTC(2026, 7, 16) },
      },
    });
    assert.equal(missingService.status, 400);
    assert.match(missingService.body.error, /service is required/);

    const badDate = await call(handler, {
      method: "POST",
      pathname: "/functions/tokentracker-subscription-manager",
      headers: auth,
      body: {
        action: "create",
        subscription: { service: "GPT", autoRenew: true, nextBillingAt: "not-a-date" },
      },
    });
    assert.equal(badDate.status, 400);
    assert.match(badDate.body.error, /nextBillingAt must be a valid date/);

    const unknownAction = await call(handler, {
      method: "POST",
      pathname: "/functions/tokentracker-subscription-manager",
      headers: auth,
      body: { action: "launch" },
    });
    assert.equal(unknownAction.status, 400);
    assert.match(unknownAction.body.error, /Unknown subscription-manager action/);

    const notFound = await call(handler, {
      method: "POST",
      pathname: "/functions/tokentracker-subscription-manager",
      headers: auth,
      body: { action: "delete", id: "no-such-id" },
    });
    assert.equal(notFound.status, 400);
    assert.match(notFound.body.error, /Subscription not found/);
  });

  it("rejects unsupported methods", async () => {
    const put = await call(handler, {
      method: "PUT",
      pathname: "/functions/tokentracker-subscription-manager",
    });
    assert.equal(put.status, 405);
  });
});
